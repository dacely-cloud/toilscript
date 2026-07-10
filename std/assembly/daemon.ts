// Daemon: the developer-facing L4 (cold box) scheduler API.
//
// `@daemon class Jobs { onStart(): void {} @scheduled("1s") tick(): void {} }`
// declares the daemon; the compiler emits the `daemon_start` / `daemon_dispatch`
// entrypoints and the `toildaemon.catalog` section. THIS file is what a task body
// calls to read its own leadership, park, introspect its schedule, and make an
// outbound HTTP request.
//
// These wrap `bindings/daemon`, whose imports live in the `daemon` wasm module
// (not `env`). They resolve only inside a cold box: calling them from a request
// handler produces a module the edge will not run.
//
// Leadership is cooperative. Exactly one node holds the lease; `isLeader()` is a
// snapshot, and a long task should re-check it (or call `yieldNow()`) rather than
// assume the lease it started with is still held. Every call that can observe a
// lost lease reports it as `DaemonError.LeaseLost`.

import { daemonHost } from "bindings/daemon";

/// The host bridges a typed failure as `-(0x10000 + code)`; this is that base.
const DAEMON_ERR_BASE: i64 = 0x10000;

/// `http_call` request caps, mirrored from the host so an over-cap envelope fails
/// in the guest instead of costing a rejected round trip (toil-backend
/// `config::daemon_http`).
const DAEMON_MAX_METHOD_BYTES: i32 = 16;
const DAEMON_MAX_URL_BYTES: i32 = 8 * 1024;
const DAEMON_MAX_HEADERS: i32 = 64;
const DAEMON_MAX_HEADER_BYTES: i32 = 8 * 1024;
const DAEMON_MAX_REQUEST_BYTES: i32 = 256 * 1024;

/// The host truncates a response body to 1 MiB. The default `httpCall` buffer is
/// smaller; callers expecting large bodies pass their own capacity.
const DAEMON_DEFAULT_RESPONSE_CAP: i32 = 64 * 1024;

/// A typed daemon failure. The three positive values are the host's u16 subsystem
/// codes (toil-backend `ERR_DAEMON_*`), bridged as `-(0x10000 + code)`. The
/// negative values are guest-side outcomes that never travel the wire.
@global
export enum DaemonError {
  /// No failure.
  None = 0,
  /// This node does not hold the lease; the host refused without acting.
  NotLeader = 0x0401,
  /// The lease was lost while the call was in flight (mid-park, mid-request).
  LeaseLost = 0x0402,
  /// The outbound request did not complete (SSRF guard, timeout, transport).
  CallFailed = 0x0405,
  /// The response did not fit the buffer. The call ALREADY HAPPENED: retrying it
  /// re-issues the request. Pass a larger `responseCap` next time instead.
  ResponseTooLarge = -1,
  /// The request violates a host cap, or the response envelope was malformed.
  /// Nothing was sent (encode) or the bytes could not be trusted (decode).
  BadEnvelope = -2,
  /// A negative status outside every band above.
  Unknown = -3,
}

/// The last failure observed by a `Daemon` call, in this instance. Read it right
/// after a call that returned `null`; any later call overwrites it.
// @ts-ignore: decorator
@lazy
var __daemonLastError: DaemonError = DaemonError.None;

/// Decode a negative host return into a typed failure. Non-negative is `None`.
function __daemonDecode(status: i64): DaemonError {
  if (status >= 0) return DaemonError.None;
  if (status == -1) return DaemonError.ResponseTooLarge;
  const code: i64 = -status - DAEMON_ERR_BASE;
  if (code < 0 || code > 0xFFFF) return DaemonError.Unknown;
  const c = <i32>code;
  if (c == <i32>DaemonError.NotLeader) return DaemonError.NotLeader;
  if (c == <i32>DaemonError.LeaseLost) return DaemonError.LeaseLost;
  if (c == <i32>DaemonError.CallFailed) return DaemonError.CallFailed;
  return DaemonError.Unknown;
}

/// Record and return the failure for `status` (`None` when it is not a failure).
function __daemonNote(status: i64): DaemonError {
  const e = __daemonDecode(status);
  __daemonLastError = e;
  return e;
}

/// One `name: value` header of an outbound request or an inbound response.
@global
export class DaemonHttpHeader {
  name: string;
  value: string;
  constructor(name: string, value: string) {
    this.name = name;
    this.value = value;
  }
}

/// An outbound HTTP request. `url` must be an absolute `http(s)` URL; the host
/// applies an SSRF guard to the resolved address, so a private/loopback target
/// fails with `DaemonError.CallFailed` rather than connecting.
@global
export class DaemonHttpRequest {
  method: string = "GET";
  url: string = "";
  headers: DaemonHttpHeader[] = [];
  body: Uint8Array = new Uint8Array(0);

  constructor(method: string = "GET", url: string = "") {
    this.method = method;
    this.url = url;
  }

  /// Append a header. Returns `this` so calls chain.
  header(name: string, value: string): DaemonHttpRequest {
    this.headers.push(new DaemonHttpHeader(name, value));
    return this;
  }

  /// Encode the little-endian request envelope the host decodes, or `null` when a
  /// field breaks a host cap (nothing is sent). Layout:
  ///   u8 methodLen | method | u16 urlLen | url | u16 nHeaders
  ///   | nHeaders * (u16 nameLen | name | u16 valLen | val)
  ///   | u32 bodyLen | body
  encode(): Uint8Array | null {
    const method = Uint8Array.wrap(String.UTF8.encode(this.method));
    const url = Uint8Array.wrap(String.UTF8.encode(this.url));
    const nHeaders = this.headers.length;
    if (method.byteLength < 1 || method.byteLength > DAEMON_MAX_METHOD_BYTES) return null;
    if (url.byteLength > DAEMON_MAX_URL_BYTES) return null;
    if (nHeaders > DAEMON_MAX_HEADERS) return null;
    if (this.body.byteLength > DAEMON_MAX_REQUEST_BYTES) return null;

    // Encode every header once: sizing and writing must agree on the byte counts.
    const names = new Array<Uint8Array>();
    const values = new Array<Uint8Array>();
    let headerBytes = 0;
    for (let i = 0; i < nHeaders; i++) {
      const h = this.headers[i];
      const n = Uint8Array.wrap(String.UTF8.encode(h.name));
      const v = Uint8Array.wrap(String.UTF8.encode(h.value));
      if (n.byteLength > DAEMON_MAX_HEADER_BYTES || v.byteLength > DAEMON_MAX_HEADER_BYTES) {
        return null;
      }
      names.push(n);
      values.push(v);
      headerBytes += 4 + n.byteLength + v.byteLength;
    }

    // The host caps `req_len`, the WHOLE envelope, not just the body, and going over
    // is a trap rather than a typed error (`daemon.http_call: req_len over cap`). So
    // the total is what must be checked: a body just under the cap plus headers and a
    // long URL would otherwise kill the daemon.
    const size = 1 + method.byteLength + 2 + url.byteLength + 2 + headerBytes + 4 + this.body.byteLength;
    if (size > DAEMON_MAX_REQUEST_BYTES) return null;

    const buf = new Uint8Array(size);
    const base = buf.dataStart;
    let off: usize = 0;

    store<u8>(base + off, <u8>method.byteLength); off += 1;
    memory.copy(base + off, method.dataStart, <usize>method.byteLength); off += <usize>method.byteLength;
    store<u16>(base + off, <u16>url.byteLength); off += 2;
    memory.copy(base + off, url.dataStart, <usize>url.byteLength); off += <usize>url.byteLength;
    store<u16>(base + off, <u16>nHeaders); off += 2;
    for (let i = 0; i < nHeaders; i++) {
      const n = names[i];
      const v = values[i];
      store<u16>(base + off, <u16>n.byteLength); off += 2;
      memory.copy(base + off, n.dataStart, <usize>n.byteLength); off += <usize>n.byteLength;
      store<u16>(base + off, <u16>v.byteLength); off += 2;
      memory.copy(base + off, v.dataStart, <usize>v.byteLength); off += <usize>v.byteLength;
    }
    store<u32>(base + off, <u32>this.body.byteLength); off += 4;
    memory.copy(base + off, this.body.dataStart, <usize>this.body.byteLength);
    return buf;
  }
}

/// An inbound HTTP response. `status` is 0 when the host itself failed before a
/// reply existed. The body is truncated by the host at 1 MiB.
@global
export class DaemonHttpResponse {
  status: u16 = 0;
  headers: DaemonHttpHeader[] = [];
  body: Uint8Array = new Uint8Array(0);

  /// Read a header's value (case-sensitive, first match), or `null`.
  header(name: string): string | null {
    for (let i = 0, n = this.headers.length; i < n; i++) {
      if (this.headers[i].name == name) return this.headers[i].value;
    }
    return null;
  }

  /// The body decoded as UTF-8.
  text(): string {
    return String.UTF8.decodeUnsafe(this.body.dataStart, <usize>this.body.byteLength);
  }

  /// Decode the little-endian response envelope, or `null` when it is truncated /
  /// self-inconsistent. Layout:
  ///   u16 status | u16 nHeaders
  ///   | nHeaders * (u16 nameLen | name | u16 valLen | val)
  ///   | u32 bodyLen | body
  static decode(buf: Uint8Array, len: i32): DaemonHttpResponse | null {
    if (len < 0 || len > buf.byteLength) return null;
    const base = buf.dataStart;
    let off = 0;

    if (off + 2 > len) return null;
    const out = new DaemonHttpResponse();
    out.status = load<u16>(base + <usize>off); off += 2;

    if (off + 2 > len) return null;
    const nHeaders = <i32>load<u16>(base + <usize>off); off += 2;
    for (let i = 0; i < nHeaders; i++) {
      if (off + 2 > len) return null;
      const nameLen = <i32>load<u16>(base + <usize>off); off += 2;
      if (off + nameLen > len) return null;
      const name = String.UTF8.decodeUnsafe(base + <usize>off, <usize>nameLen); off += nameLen;

      if (off + 2 > len) return null;
      const valLen = <i32>load<u16>(base + <usize>off); off += 2;
      if (off + valLen > len) return null;
      const value = String.UTF8.decodeUnsafe(base + <usize>off, <usize>valLen); off += valLen;

      out.headers.push(new DaemonHttpHeader(name, value));
    }

    if (off + 4 > len) return null;
    const bodyLen = <i32>load<u32>(base + <usize>off); off += 4;
    if (bodyLen < 0 || off + bodyLen > len) return null;
    const body = new Uint8Array(bodyLen);
    memory.copy(body.dataStart, base + <usize>off, <usize>bodyLen); off += bodyLen;

    // A trailing tail means the guest and the host disagree on the framing.
    if (off != len) return null;
    out.body = body;
    return out;
  }
}

/// The daemon scheduler surface. Every member is static: a cold box has exactly
/// one daemon, and these read the resident host state.
@global
export class Daemon {
  /// Whether THIS node currently holds the lease. A snapshot: re-check it inside a
  /// long task rather than trusting the value it started with.
  static isLeader(): bool {
    return daemonHost.isLeader() != 0;
  }

  /// The monotonic fencing token, bumped on every (re)acquire, or -1 when this
  /// node does not hold the lease. Stamp it into work that must not outlive the
  /// lease that authorized it.
  static epoch(): i64 {
    return daemonHost.currentEpoch();
  }

  /// The number of registered `@scheduled` tasks.
  static taskCount(): i32 {
    return daemonHost.taskCount();
  }

  /// The next wall-clock fire time for `taskId` in epoch ms, or -1 for an
  /// out-of-range id or a cron that never fires again.
  static nextFireMs(taskId: i32): i64 {
    return daemonHost.nextFireMs(taskId);
  }

  /// Give the host a chance to observe a lost lease. `None` means still leader.
  /// Named `yieldNow` because `yield` is reserved.
  static yieldNow(): DaemonError {
    return __daemonNote(<i64>daemonHost.yieldNow());
  }

  /// Park for `ms`, clamped by the host to its 3s ceiling (a negative `ms` does
  /// not park at all). `None` means the sleep completed and the lease still holds;
  /// `LeaseLost` means it was lost while parked, and the task should stop.
  static sleep(ms: i64): DaemonError {
    return __daemonNote(<i64>daemonHost.sleepMs(ms));
  }

  /// Make an outbound HTTP request. Returns the response, or `null` on failure
  /// (read `Daemon.lastError()`).
  ///
  /// `responseCap` sizes the guest buffer the host writes into. When the envelope
  /// does not fit, this returns `null` with `ResponseTooLarge` and DOES NOT retry:
  /// the request already went out, so a blind retry would issue it twice. Pass a
  /// bigger `responseCap` if you expect a large body.
  static httpCall(
    request: DaemonHttpRequest,
    responseCap: i32 = DAEMON_DEFAULT_RESPONSE_CAP,
  ): DaemonHttpResponse | null {
    const req = request.encode();
    if (req == null) {
      __daemonLastError = DaemonError.BadEnvelope;
      return null;
    }
    const reqBuf = <Uint8Array>req;
    const cap = responseCap > 0 ? responseCap : DAEMON_DEFAULT_RESPONSE_CAP;
    const out = new Uint8Array(cap);
    const n = daemonHost.httpCall(reqBuf.dataStart, reqBuf.byteLength, out.dataStart, cap);
    if (n < 0) {
      __daemonNote(n);
      return null;
    }
    const res = DaemonHttpResponse.decode(out, <i32>n);
    __daemonLastError = res == null ? DaemonError.BadEnvelope : DaemonError.None;
    return res;
  }

  /// The failure recorded by the most recent `Daemon` call.
  static lastError(): DaemonError {
    return __daemonLastError;
  }
}
