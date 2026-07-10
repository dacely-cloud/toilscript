// Exercises the `~lib/daemon` surface against a host that reimplements the
// toil-backend framing (see `run.mjs`). Every export returns 0 on success and a
// negative code (or a `DaemonError`) on mismatch, so the runner can name the case.
//
// The imports MUST land in the `daemon` wasm module, not as dotted names under
// `env`: `run.mjs` asserts that too, because a cold box that gets it wrong
// resolves in a dev emulator and trap-stubs at the edge.

export function roundtrip(): i32 {
  const req = new DaemonHttpRequest("POST", "https://example.com/x");
  req.header("content-type", "application/json");
  req.header("x-req", "42");
  req.body = Uint8Array.wrap(String.UTF8.encode("{\"a\":1}"));

  const res = Daemon.httpCall(req, 4096);
  if (res == null) return -100 + <i32>Daemon.lastError();
  const r = <DaemonHttpResponse>res;
  if (r.status != 201) return -1;
  if (r.headers.length != 2) return -2;
  const h = r.header("x-a");
  if (h == null) return -3;
  if (<string>h != "1") return -4;
  const h2 = r.header("x-b");
  if (h2 == null) return -5;
  if (<string>h2 != "2") return -6;
  if (r.text() != "hello") return -7;
  if (r.header("missing") != null) return -8;
  return 0;
}

/// No headers and an empty body still frame correctly (the zero-length edges).
export function minimal(): i32 {
  const req = new DaemonHttpRequest("GET", "https://example.com/");
  const res = Daemon.httpCall(req, 4096);
  if (res == null) return -100 + <i32>Daemon.lastError();
  const r = <DaemonHttpResponse>res;
  if (r.status != 204) return -1;
  if (r.headers.length != 0) return -2;
  if (r.body.byteLength != 0) return -3;
  return 0;
}

/// A response that does not fit reports `ResponseTooLarge`, NOT a silent retry.
export function tooSmall(): i32 {
  const req = new DaemonHttpRequest("GET", "https://example.com/x");
  const res = Daemon.httpCall(req, 4);
  if (res != null) return -1;
  return <i32>Daemon.lastError();
}

/// An over-cap method fails closed in the guest: the request never reaches the wire.
export function badEnvelope(): i32 {
  const req = new DaemonHttpRequest("THIS_METHOD_IS_WAY_TOO_LONG", "https://example.com/x");
  const res = Daemon.httpCall(req);
  if (res != null) return -1;
  return <i32>Daemon.lastError();
}

/// The host caps the WHOLE envelope at 256 KiB and TRAPS when `req_len` exceeds it.
/// A body that fits on its own, plus headers, can still push the envelope over: the
/// guest must refuse before the call, or the daemon dies.
export function oversizeEnvelope(): i32 {
  const req = new DaemonHttpRequest("POST", "https://example.com/x");
  // Body alone is under the 256 KiB cap...
  req.body = new Uint8Array(256 * 1024 - 1024);
  // ...but 8 headers of 8 KiB each push the envelope over it.
  for (let i = 0; i < 8; i++) {
    req.header("x-pad-" + i.toString(), "p".repeat(8 * 1024 - 16));
  }
  const res = Daemon.httpCall(req);
  if (res != null) return -1;
  return <i32>Daemon.lastError();
}

/// A body that alone exceeds the cap is refused too.
export function oversizeBody(): i32 {
  const req = new DaemonHttpRequest("POST", "https://example.com/x");
  req.body = new Uint8Array(256 * 1024 + 1);
  const res = Daemon.httpCall(req);
  if (res != null) return -1;
  return <i32>Daemon.lastError();
}

/// An envelope that exactly fills the cap is still allowed through.
export function maxEnvelopeAllowed(): i32 {
  const req = new DaemonHttpRequest("GET", "https://example.com/");
  // 1 + 3 (GET) + 2 + 20 (url) + 2 + 0 (headers) + 4 = 32 bytes of framing.
  req.body = new Uint8Array(256 * 1024 - 32);
  const res = Daemon.httpCall(req, 4096);
  if (res == null) return -100 + <i32>Daemon.lastError();
  return (<DaemonHttpResponse>res).status == 204 ? 0 : -1;
}

/// A bridged `-(0x10000 + code)` host failure decodes to its typed `DaemonError`.
export function callFailed(): i32 {
  const req = new DaemonHttpRequest("GET", "https://blocked.invalid/x");
  const res = Daemon.httpCall(req);
  if (res != null) return -1;
  return <i32>Daemon.lastError();
}

/// A response whose framing disagrees with its own lengths is refused.
export function truncatedResponse(): i32 {
  const req = new DaemonHttpRequest("GET", "https://example.com/truncated");
  const res = Daemon.httpCall(req, 4096);
  if (res != null) return -1;
  return <i32>Daemon.lastError();
}

export function leaderChecks(): i32 {
  if (!Daemon.isLeader()) return -1;
  if (Daemon.epoch() != 7) return -2;
  if (Daemon.taskCount() != 3) return -3;
  if (Daemon.nextFireMs(0) != 1234) return -4;
  if (Daemon.nextFireMs(99) != -1) return -5;
  if (Daemon.yieldNow() != DaemonError.None) return -6;
  return 0;
}

/// A lost lease surfaces as the typed `LeaseLost`, not a raw negative number.
export function leaseLost(): i32 {
  const e = Daemon.sleep(10);
  if (e != DaemonError.LeaseLost) return -1;
  if (Daemon.lastError() != DaemonError.LeaseLost) return -2;
  if (Daemon.yieldNow() != DaemonError.LeaseLost) return -3;
  return 0;
}

/// A non-leader `epoch()` is -1 (the host's EPOCH_NONE), not an error code.
export function epochNone(): i32 {
  if (Daemon.epoch() != -1) return -1;
  return 0;
}
