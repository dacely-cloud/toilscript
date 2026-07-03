// ToilDB: the developer-facing edge-database API.
//
// `@database class App { @collection(...) users!: Documents<UserId, User>; ... }`
// declares logical collections; the compiler (see parser `injectDatabaseBinding`)
// synthesizes a `@global App` singleton whose fields are these typed handles,
// resolved to numeric host handles once at module init.
//
// The handles marshal `@data` keys/values to the `env.data.*` host imports
// (`bindings/toildb`). Keys and values are `@data` types (they have the injected
// `encode(): Uint8Array` + `decodeInto(buf): void` instance methods). Both
// encode and decode go through INSTANCE methods on the generic type parameter,
// which AssemblyScript resolves at specialization (it cannot call the `decode`
// static through a type parameter, but `instantiate<V>()` + `v.decodeInto(buf)`
// works). Value types must be default-constructible.

import { analyticsHost, toildbHost } from "bindings/toildb";
import { DataReader, DataWriter } from "data";

/// Resolve a `"<db>/<collection>"` name to its numeric host handle. Called once
/// per collection at module init by the generated `App` binding.
export function __toildbResolve(name: string): u32 {
  const nb = Uint8Array.wrap(String.UTF8.encode(name));
  const out = new Uint8Array(4);
  const status = toildbHost.resolveCollection(nb.dataStart, nb.byteLength, out.dataStart);
  if (status < 0) abort("ToilDB collection resolve failed", "toildb", 0, 0);
  return load<u32>(out.dataStart);
}

/// The schema version of the last value-returning read's row (or -1). The
/// generated `decodeInto` of a `@migrate`-d value type calls this to dispatch an
/// old-layout row through its transform. Global so generated user-code reaches it
/// (like `__toildbResolve`).
export function __toildbReadVersion(): i64 {
  return toildbHost.resultSchemaVersion();
}

/// Set true by a woven `decodeInto` when it migrates an old-layout row, so the
/// reading handle can converge the row (rewrite-on-read). The handle resets it
/// before each decode and reads it after; the dispatch marks it AFTER the
/// transform runs, so a transform that itself reads (resetting the flag) does not
/// clear the outer migration.
// `@lazy`: initialized on first access rather than in module-init order. A value
// type's woven `decodeInto` (which, under the cross-file `@migrate` convention,
// lives in a DIFFERENT module than this one) compiles these exported accessors on
// demand; @lazy breaks the init-order dependency so that never trips a
// use-before-declaration that a plain global would in that circular import graph.
// @ts-ignore: decorator
@lazy
var __toildbMigratedFlag: bool = false;
export function __toildbResetMigrated(): void { __toildbMigratedFlag = false; }
export function __toildbMarkMigrated(): void { __toildbMigratedFlag = true; }
export function __toildbWasMigrated(): bool { return __toildbMigratedFlag; }

/// Pull the last stashed variable-length result of `len` bytes into a buffer.
function __toildbTake(len: i32): Uint8Array {
  const buf = new Uint8Array(len);
  toildbHost.takeResult(buf.dataStart, len);
  return buf;
}

/// Pull a stashed result whose length is NOT known up front (e.g. the owner
/// returned by a failed `claim`): grow the buffer until `take_result` fits.
function __toildbTakeGrow(): Uint8Array {
  let cap = 256;
  let buf = new Uint8Array(cap);
  let n = toildbHost.takeResult(buf.dataStart, cap);
  while (n == -1) {
    cap = cap * 2;
    buf = new Uint8Array(cap);
    n = toildbHost.takeResult(buf.dataStart, cap);
  }
  return buf.subarray(0, n);
}

/// A mutable keyed-entity collection (spec 7.1). `V` is the `@data` value type,
/// `K` the `@data` key type.
@global
export class Documents<K, V> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// Return the record, or `null` if it does not exist.
  get(key: K): V | null {
    const kb = key.encode();
    const status = toildbHost.get(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) return null;
    __toildbResetMigrated();
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    // Rewrite-on-read convergence: if this row was lazily migrated from an older
    // layout AND the current call may write, persist the migrated value so it
    // stops being re-migrated. Best-effort: a read-only kind skips it, and a
    // failed patch is ignored (the in-memory value is already correct).
    if (__toildbWasMigrated() && toildbHost.writeAllowed() == 1) {
      const nb = v.encode();
      toildbHost.patch(this.__handle, kb.dataStart, kb.byteLength, nb.dataStart, nb.byteLength, 0);
    }
    return v;
  }

  /// Like `get`, but traps if the record is absent.
  require(key: K): V {
    const v = this.get(key);
    if (v == null) unreachable();
    return v!;
  }

  /// Bounded multi-get: one op, one result per key (in order), each the value
  /// or `null` if absent. The key count is capped by the request budget.
  getMany(keys: K[]): Array<V | null> {
    const w = new DataWriter();
    w.writeU32(<u32>keys.length);
    for (let i = 0, n = keys.length; i < n; i++) {
      w.writeBytes(keys[i].encode());
    }
    const blob = w.toBytes();
    const status = toildbHost.getMany(this.__handle, blob.dataStart, blob.byteLength);
    if (status < 0) unreachable();
    const out = __toildbTake(status);
    const results = new Array<V | null>();
    let off: i32 = 0;
    const count = load<u32>(out.dataStart + off);
    off += 4;
    for (let i: u32 = 0; i < count; i++) {
      const present = load<u8>(out.dataStart + off);
      off += 1;
      if (present == 0) {
        results.push(null);
        continue;
      }
      const ver = <i64>load<u32>(out.dataStart + off);
      off += 4;
      const len = <i32>load<u32>(out.dataStart + off);
      off += 4;
      const v = instantiate<V>();
      v.decodeIntoVersioned(out.subarray(off, off + len), ver);
      off += len;
      results.push(v);
    }
    return results;
  }

  /// Whether the record exists.
  exists(key: K): bool {
    const kb = key.encode();
    return toildbHost.exists(this.__handle, kb.dataStart, kb.byteLength) == 1;
  }

  /// Create the record if absent. Returns false if it already existed.
  create(key: K, value: V): bool {
    const kb = key.encode();
    const vb = value.encode();
    return toildbHost.create(
      this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0
    ) == 0;
  }

  /// Apply a write through the key's home cell; returns the stored record.
  patch(key: K, value: V): V {
    const kb = key.encode();
    const vb = value.encode();
    const status = toildbHost.patch(
      this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0
    );
    if (status < 0) unreachable();
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    return v;
  }

  /// Atomically replace an EXISTING record's value, version-checked: returns true
  /// if applied, false if a concurrent write changed the record first (optimistic
  /// concurrency - re-read and retry) or the record is absent.
  enqueue(key: K, value: V): bool {
    const kb = key.encode();
    const vb = value.encode();
    return toildbHost.enqueue(this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0) == 0;
  }

  /// Delete the record (idempotent).
  delete(key: K): void {
    const kb = key.encode();
    toildbHost.del(this.__handle, kb.dataStart, kb.byteLength, 0);
  }

  /// Atomic fetch-and-delete (consume-once); returns the prior value or `null`.
  getDelete(key: K): V | null {
    const kb = key.encode();
    const status = toildbHost.getDelete(this.__handle, kb.dataStart, kb.byteLength, 0);
    if (status < 0) return null;
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    return v;
  }
}

/// A precomputed, read-optimized projection (spec 7.2): home pages,
/// leaderboards, rendered fragments. Read by any function kind; PUBLISHED only
/// by a `@derive`/`@job` (the host kind gate enforces it). `V` is the `@data`
/// value type, `K` the `@data` key type.
@global
export class View<K, V> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// The published view for `key`, or `null` if none has been published.
  get(key: K): V | null {
    const kb = key.encode();
    const status = toildbHost.viewGet(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) return null;
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    return v;
  }

  /// Like `get`, but traps if no view is published.
  require(key: K): V {
    const v = this.get(key);
    if (v == null) unreachable();
    return v!;
  }

  /// Publish (overwrite) the view for `key`. Derive/job only; the host assigns
  /// the version so a later publish always supersedes an earlier one.
  publish(key: K, value: V): void {
    const kb = key.encode();
    const vb = value.encode();
    toildbHost.viewPublish(
      this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0
    );
  }
}

/// The result of a `unique.claim` (spec 8.6). `claimed` is true when the caller
/// owns the key (a fresh claim or an idempotent re-claim of its own); when
/// false, `owner` is the value that currently holds the key.
@global
export class ClaimResult<V> {
  constructor(public claimed: bool, public owner: V | null) {}
}

/// A globally-unique claim collection (spec 7.6): username, email, slug, ...
/// `V` is the `@data` OWNER value type, `K` the `@data` claim-key type.
@global
export class Unique<K, V> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// The value that owns `key`, or `null` if unclaimed.
  lookup(key: K): V | null {
    const kb = key.encode();
    const status = toildbHost.uniqueLookup(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) return null;
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    return v;
  }

  /// Claim `key` for `value`. Returns whether the caller owns it, and (when
  /// another owns it) who.
  claim(key: K, value: V): ClaimResult<V> {
    const kb = key.encode();
    const vb = value.encode();
    const tag = toildbHost.uniqueClaim(
      this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0
    );
    if (tag < 0) unreachable();
    if (tag == 1) {
      // AlreadyClaimed: the current owner is stashed.
      const owner = instantiate<V>();
      owner.decodeInto(__toildbTakeGrow());
      return new ClaimResult<V>(false, owner);
    }
    // 0 Claimed, 2 AlreadyOwnedByCaller -> the caller owns it.
    return new ClaimResult<V>(true, null);
  }

  /// Release `key` (only the current owner may; a non-owner release traps).
  release(key: K, value: V): void {
    const kb = key.encode();
    const vb = value.encode();
    toildbHost.uniqueRelease(
      this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0
    );
  }
}

/// An unordered set (spec 7.3): followers, tags, ACLs, room members. `M` is the
/// `@data` member type, `K` the `@data` set-key type.
@global
export class Membership<K, M> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// Whether `member` is in the set keyed by `key`.
  contains(key: K, member: M): bool {
    const kb = key.encode();
    const mb = member.encode();
    return toildbHost.membershipContains(
      this.__handle, kb.dataStart, kb.byteLength, mb.dataStart, mb.byteLength
    ) == 1;
  }

  /// Add `member` to the set (idempotent).
  add(key: K, member: M): void {
    const kb = key.encode();
    const mb = member.encode();
    toildbHost.membershipAdd(
      this.__handle, kb.dataStart, kb.byteLength, mb.dataStart, mb.byteLength, 0
    );
  }

  /// Remove `member` from the set (idempotent).
  remove(key: K, member: M): void {
    const kb = key.encode();
    const mb = member.encode();
    toildbHost.membershipRemove(
      this.__handle, kb.dataStart, kb.byteLength, mb.dataStart, mb.byteLength, 0
    );
  }

  /// Up to `limit` members of the set. Decodes each framed member into an `M`.
  list(key: K, limit: i32): M[] {
    const kb = key.encode();
    const status = toildbHost.membershipList(this.__handle, kb.dataStart, kb.byteLength, limit);
    if (status < 0) unreachable();
    const blob = __toildbTake(status);
    const out = new Array<M>();
    let off: i32 = 0;
    const count = load<u32>(blob.dataStart + off);
    off += 4;
    for (let i: u32 = 0; i < count; i++) {
      const ver = <i64>load<u32>(blob.dataStart + off);
      off += 4;
      const len = <i32>load<u32>(blob.dataStart + off);
      off += 4;
      const m = instantiate<M>();
      m.decodeIntoVersioned(blob.subarray(off, off + len), ver);
      out.push(m);
      off += len;
    }
    return out;
  }
}

/// A finite, strongly-consistent resource (spec 7.7): limited stock, seats,
/// rate grants. Reserve/confirm/cancel two-phase holds prevent oversell. `K` is
/// the `@data` key type (the value is the host-owned escrow ledger).
@global
export class Capacity<K> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// Units available to reserve right now.
  available(key: K): i64 {
    const kb = key.encode();
    const status = toildbHost.capacityAvailable(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) unreachable();
    return load<i64>(__toildbTake(status).dataStart);
  }

  /// Hold `amount` for `ttlMs` (it auto-releases if not confirmed in time).
  /// Returns the reservation id (> 0), or 0 if there was not enough available
  /// (no oversell).
  reserve(key: K, amount: i64, ttlMs: i64): u64 {
    const kb = key.encode();
    const status = toildbHost.capacityReserve(
      this.__handle, kb.dataStart, kb.byteLength, amount, ttlMs, 0
    );
    if (status == -2) return 0; // insufficient
    if (status < 0) unreachable();
    return load<u64>(__toildbTake(status).dataStart);
  }

  /// Finalize a hold into a permanent consume. Returns whether the id was valid.
  confirm(key: K, reservationId: u64): bool {
    const kb = key.encode();
    return toildbHost.capacityConfirm(
      this.__handle, kb.dataStart, kb.byteLength, reservationId as i64, 0
    ) == 1;
  }

  /// Release a hold back to available (a confirmed sale cannot be cancelled).
  cancel(key: K, reservationId: u64): bool {
    const kb = key.encode();
    return toildbHost.capacityCancel(
      this.__handle, kb.dataStart, kb.byteLength, reservationId as i64, 0
    ) == 1;
  }

  /// Set the ceiling (restock / reduce). `@job`/`@derive` only; the kind gate
  /// (compile + runtime) enforces it.
  setTotal(key: K, total: i64): void {
    const kb = key.encode();
    toildbHost.capacitySetTotal(this.__handle, kb.dataStart, kb.byteLength, total, 0);
  }
}

/// A commutative integer counter (spec 7.4): likes, view counts, inventory.
/// `K` is the `@data` key type; the value is a host-aggregated i64 rollup (there
/// is no `set`, only `add` and `get`, so concurrent deltas never lose writes).
@global
export class Counter<K> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// The current sum (0 if no deltas have been applied).
  get(key: K): i64 {
    const kb = key.encode();
    const status = toildbHost.counterGet(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) unreachable();
    const buf = __toildbTake(status);
    return load<i64>(buf.dataStart);
  }

  /// Apply a (possibly negative) delta; saturates at the i64 bounds.
  add(key: K, delta: i64): void {
    const kb = key.encode();
    toildbHost.counterAdd(this.__handle, kb.dataStart, kb.byteLength, delta, 0);
  }
}

/// Every per-domain metric, by stable numeric id. This is the WIRE CONTRACT shared with the edge
/// (`src/analytics/metric_id.rs`) and the dev server; it orders the snapshot frame and addresses a
/// time-series. Ids `0..=42` are cumulative COUNTERS (a rate is `value / seconds`); `43..=46` are the
/// avg/peak series of the two GAUGES. Append-only: never renumber.
export enum MetricId {
  Requests = 0,
  BytesOutL1 = 1,
  BytesInL1 = 2,
  Status2xx = 3,
  Status3xx = 4,
  Status4xx = 5,
  Status5xx = 6,
  StaticHits = 7,
  WasmDispatches = 8,
  ExecutorFullRejects = 9,
  UnknownHostRejects = 10,
  RateLimitedRejects = 11,
  GasUsed = 12,
  DbOps = 13,
  DbReads = 14,
  DbWrites = 15,
  DbErrors = 16,
  DbLatencyNsSum = 17,
  StreamAccepts = 18,
  StreamRejectWrongNode = 19,
  StreamRejectCapacity = 20,
  StreamRejectArtifact = 21,
  StreamRejectGuest = 22,
  StreamTraps = 23,
  StreamIdleTimeouts = 24,
  StreamBytesIn = 25,
  StreamBytesOut = 26,
  StreamBackpressureEvents = 27,
  StreamCloses = 28,
  StreamDisconnects = 29,
  DaemonStarts = 30,
  DaemonStartFailures = 31,
  DaemonTicksFired = 32,
  DaemonTicksSkippedNotLeader = 33,
  DaemonTicksFailed = 34,
  DaemonLeaderAcquires = 35,
  DaemonLeaderFenced = 36,
  DaemonHttpCallAttempts = 37,
  DaemonHttpCallFailures = 38,
  MemGrownBytes = 39,
  Emails = 40,
  CacheHits = 41,
  CacheMisses = 42,
  ConnectedStreamsAvg = 43,
  ConnectedStreamsPeak = 44,
  CommittedMemoryAvg = 45,
  CommittedMemoryPeak = 46,
}

/// The number of cumulative counter metrics (`MetricId 0..=42`) = the length of the snapshot's lifetime
/// section.
export const METRIC_COUNTERS: i32 = 43;

/// A dashboard time range for `Analytics.series`. Short ranges (1h/6h) read the per-MINUTE ring; the rest
/// read the per-HOUR ring (30-day retention).
export enum AnalyticsRange {
  H1 = 0,
  H6 = 1,
  H12 = 2,
  H24 = 3,
  D3 = 4,
  D7 = 5,
  D14 = 6,
  D30 = 7,
}

/// One tenant's analytics snapshot: the lifetime totals (indexed by `MetricId`, NO string keys), the two
/// live gauge levels, and the request windows paired with the plan caps (cap 0 = unlimited). Read every
/// value either by the typed getter (`stats.requests`) or by id (`stats.metric(MetricId.Requests)`).
export class TenantStats {
  /// Lifetime totals indexed by `MetricId` (length `METRIC_COUNTERS`). Prefer the named getters below.
  life: StaticArray<u64> = new StaticArray<u64>(METRIC_COUNTERS);
  /// Live gauges (current level, not a total).
  connectedStreams: u64 = 0;
  committedMemory: u64 = 0;
  /// Request windows: current bucket usage + plan cap (0 = unlimited).
  reqMinuteUsed: u64 = 0;
  reqMinuteCap: u64 = 0;
  reqDayUsed: u64 = 0;
  reqDayCap: u64 = 0;
  /// Edge wall-clock (ms) when the snapshot was read.
  nowMs: u64 = 0;

  /// Any counter metric by id (0 for an out-of-range id).
  metric(id: MetricId): u64 {
    return <i32>id < METRIC_COUNTERS ? this.life[<i32>id] : 0;
  }

  // Typed getters for every counter (the catalog: no magic strings, self-documenting).
  get requests(): u64 { return this.life[MetricId.Requests]; }
  get bytesOutL1(): u64 { return this.life[MetricId.BytesOutL1]; }
  get bytesInL1(): u64 { return this.life[MetricId.BytesInL1]; }
  get status2xx(): u64 { return this.life[MetricId.Status2xx]; }
  get status3xx(): u64 { return this.life[MetricId.Status3xx]; }
  get status4xx(): u64 { return this.life[MetricId.Status4xx]; }
  get status5xx(): u64 { return this.life[MetricId.Status5xx]; }
  get staticHits(): u64 { return this.life[MetricId.StaticHits]; }
  get wasmDispatches(): u64 { return this.life[MetricId.WasmDispatches]; }
  get executorFullRejects(): u64 { return this.life[MetricId.ExecutorFullRejects]; }
  get unknownHostRejects(): u64 { return this.life[MetricId.UnknownHostRejects]; }
  get rateLimitedRejects(): u64 { return this.life[MetricId.RateLimitedRejects]; }
  get gasUsed(): u64 { return this.life[MetricId.GasUsed]; }
  get dbOps(): u64 { return this.life[MetricId.DbOps]; }
  get dbReads(): u64 { return this.life[MetricId.DbReads]; }
  get dbWrites(): u64 { return this.life[MetricId.DbWrites]; }
  get dbErrors(): u64 { return this.life[MetricId.DbErrors]; }
  get dbLatencyNsSum(): u64 { return this.life[MetricId.DbLatencyNsSum]; }
  get streamAccepts(): u64 { return this.life[MetricId.StreamAccepts]; }
  get streamRejectWrongNode(): u64 { return this.life[MetricId.StreamRejectWrongNode]; }
  get streamRejectCapacity(): u64 { return this.life[MetricId.StreamRejectCapacity]; }
  get streamRejectArtifact(): u64 { return this.life[MetricId.StreamRejectArtifact]; }
  get streamRejectGuest(): u64 { return this.life[MetricId.StreamRejectGuest]; }
  get streamTraps(): u64 { return this.life[MetricId.StreamTraps]; }
  get streamIdleTimeouts(): u64 { return this.life[MetricId.StreamIdleTimeouts]; }
  get streamBytesIn(): u64 { return this.life[MetricId.StreamBytesIn]; }
  get streamBytesOut(): u64 { return this.life[MetricId.StreamBytesOut]; }
  get streamBackpressureEvents(): u64 { return this.life[MetricId.StreamBackpressureEvents]; }
  get streamCloses(): u64 { return this.life[MetricId.StreamCloses]; }
  get streamDisconnects(): u64 { return this.life[MetricId.StreamDisconnects]; }
  get daemonStarts(): u64 { return this.life[MetricId.DaemonStarts]; }
  get daemonStartFailures(): u64 { return this.life[MetricId.DaemonStartFailures]; }
  get daemonTicksFired(): u64 { return this.life[MetricId.DaemonTicksFired]; }
  get daemonTicksSkippedNotLeader(): u64 { return this.life[MetricId.DaemonTicksSkippedNotLeader]; }
  get daemonTicksFailed(): u64 { return this.life[MetricId.DaemonTicksFailed]; }
  get daemonLeaderAcquires(): u64 { return this.life[MetricId.DaemonLeaderAcquires]; }
  get daemonLeaderFenced(): u64 { return this.life[MetricId.DaemonLeaderFenced]; }
  get daemonHttpCallAttempts(): u64 { return this.life[MetricId.DaemonHttpCallAttempts]; }
  get daemonHttpCallFailures(): u64 { return this.life[MetricId.DaemonHttpCallFailures]; }
  get memGrownBytes(): u64 { return this.life[MetricId.MemGrownBytes]; }
  get emails(): u64 { return this.life[MetricId.Emails]; }
  get cacheHits(): u64 { return this.life[MetricId.CacheHits]; }
  get cacheMisses(): u64 { return this.life[MetricId.CacheMisses]; }

  /// Mean host-observed DB op latency (ns), or 0 with no ops.
  get meanDbLatencyNs(): u64 {
    const ops = this.dbOps;
    return ops > 0 ? this.dbLatencyNsSum / ops : 0;
  }

  /// Fraction of cacheable responses served from cache (`hits / (hits + misses)`),
  /// 0.0 when there were no cacheable responses.
  get cacheRatio(): f64 {
    const hits = this.cacheHits;
    const total = hits + this.cacheMisses;
    return total > 0 ? <f64>hits / <f64>total : 0.0;
  }
}

/// One metric's time series for a range: `points` oldest→newest, `bucketSecs` the per-bucket width, and
/// `headMs` the newest bucket's end. Rates are derived, never stored.
export class Series {
  metric: MetricId = MetricId.Requests;
  bucketSecs: u32 = 0;
  headMs: u64 = 0;
  points: i64[] = [];

  /// Per-second rate of bucket `i` (its total divided by the bucket width). 0 for an out-of-range index.
  ratePerSec(i: i32): f64 {
    if (i < 0 || i >= this.points.length || this.bucketSecs == 0) return 0;
    return <f64>this.points[i] / <f64>this.bucketSecs;
  }
}

/// A page of site names from `Analytics.listSites` (dacely.com only). When `hasMore` is
/// true, pass the last `sites` entry back as the next call's cursor.
export class SiteList {
  sites: string[] = [];
  hasMore: bool = false;
}

/// Per-domain analytics. A site reads its OWN stats with `Analytics.self()`. The
/// privileged `dacely.com` domain may read ANY site with `Analytics.site(domain)`; any
/// other caller gets `null` for a cross-domain read (`null` is also an unknown domain).
/// The trusted calling domain is decided host-side — the guest cannot forge it.
export class Analytics {
  private static decode(buf: Uint8Array): TenantStats {
    const r = new DataReader(buf);
    const stats = new TenantStats();
    const version = r.readU16();
    if (version < 2) return stats; // pre-v2 edge: refuse rather than mis-decode
    stats.nowMs = r.readU64();
    const count = <i32>r.readU32();
    for (let i: i32 = 0; i < count && r.ok; i++) {
      // Wire fields are non-negative i64; read the same bytes as u64.
      const v = r.readU64();
      if (i < METRIC_COUNTERS) stats.life[i] = v; // ignore any extra (forward-compat)
    }
    stats.connectedStreams = r.readU64();
    stats.committedMemory = r.readU64();
    stats.reqMinuteUsed = r.readU64();
    stats.reqMinuteCap = r.readU64();
    stats.reqDayUsed = r.readU64();
    stats.reqDayCap = r.readU64();
    return stats;
  }

  private static decodeSeries(buf: Uint8Array): Series {
    const r = new DataReader(buf);
    const out = new Series();
    const version = r.readU16();
    if (version < 2) return out;
    out.metric = <MetricId>r.readU16();
    out.bucketSecs = r.readU32();
    out.headMs = r.readU64();
    const count = <i32>r.readU32();
    const pts = new Array<i64>(count);
    for (let i: i32 = 0; i < count && r.ok; i++) pts[i] = r.readI64();
    out.points = pts;
    return out;
  }

  /// This site's own analytics. Returns empty stats if unavailable.
  static self(): TenantStats {
    const status = analyticsHost.read(0, 0);
    if (status < 0) return new TenantStats();
    return Analytics.decode(__toildbTake(status));
  }

  /// Another site's analytics. Only `dacely.com` may call this for a domain other than
  /// its own; every other caller (and an unknown domain) gets `null`.
  static site(domain: string): TenantStats | null {
    const db = Uint8Array.wrap(String.UTF8.encode(domain));
    const status = analyticsHost.read(db.dataStart, db.byteLength);
    if (status < 0) return null;
    return Analytics.decode(__toildbTake(status));
  }

  /// This site's time-series for `metric` over `range` (for graphs). Empty series if unavailable.
  static series(metric: MetricId, range: AnalyticsRange): Series {
    const status = analyticsHost.series(0, 0, <i32>metric, <i32>range);
    if (status < 0) return new Series();
    return Analytics.decodeSeries(__toildbTake(status));
  }

  /// Another site's time-series (dacely.com only, else `null`).
  static siteSeries(domain: string, metric: MetricId, range: AnalyticsRange): Series | null {
    const db = Uint8Array.wrap(String.UTF8.encode(domain));
    const status = analyticsHost.series(db.dataStart, db.byteLength, <i32>metric, <i32>range);
    if (status < 0) return null;
    return Analytics.decodeSeries(__toildbTake(status));
  }

  /// Enumerate sites, paginated. ONLY `dacely.com` gets results; any other caller gets an
  /// empty list. `cursor` is the previous page's last name (`""` = from the start); reads up
  /// to `limit` names. When `hasMore` is true, pass the last `sites` entry as the next cursor.
  static listSites(cursor: string = "", limit: i32 = 256): SiteList {
    const cb = Uint8Array.wrap(String.UTF8.encode(cursor));
    const out = new SiteList();
    const status = analyticsHost.listSites(cb.dataStart, cb.byteLength, limit);
    if (status < 0) return out;
    const r = new DataReader(__toildbTake(status));
    const count = r.readU32();
    for (let i: u32 = 0; i < count && r.ok; i++) {
      out.sites.push(r.readString());
    }
    out.hasMore = r.readU8() != 0;
    return out;
  }
}

/// An append-only event log (spec 7.5): activity feeds, audit trails, the
/// fact stream a `@derive` consumes. `V` is the `@data` event type, `K` the
/// `@data` stream-key type.
@global
export class Events<K, V> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// Append an event to the stream.
  append(key: K, event: V): void {
    const kb = key.encode();
    const eb = event.encode();
    toildbHost.append(this.__handle, kb.dataStart, kb.byteLength, eb.dataStart, eb.byteLength, 0);
  }

  /// Append `event` exactly once per `eventId`: a retried call with the same id is
  /// a no-op and returns false; the first call appends and returns true. Idempotent
  /// under at-least-once delivery / client retries (dedup on the caller-chosen id).
  appendOnce(key: K, eventId: string, event: V): bool {
    const kb = key.encode();
    const idb = Uint8Array.wrap(String.UTF8.encode(eventId));
    const eb = event.encode();
    const status = toildbHost.appendOnce(
      this.__handle, kb.dataStart, kb.byteLength,
      idb.dataStart, idb.byteLength, eb.dataStart, eb.byteLength);
    if (status < 0) unreachable();
    return status == 1;
  }

  /// The newest `limit` events, newest first. Decodes each framed event into a
  /// `V`. The host frames them as `u32 count` then per event
  /// `u32 schema_version + u32 len + bytes`.
  latest(key: K, limit: i32): V[] {
    const kb = key.encode();
    const status = toildbHost.latest(this.__handle, kb.dataStart, kb.byteLength, limit);
    if (status < 0) unreachable();
    const blob = __toildbTake(status);
    const out = new Array<V>();
    let off: i32 = 0;
    const count = load<u32>(blob.dataStart + off);
    off += 4;
    for (let i: u32 = 0; i < count; i++) {
      const ver = <i64>load<u32>(blob.dataStart + off);
      off += 4;
      const len = <i32>load<u32>(blob.dataStart + off);
      off += 4;
      const ev = instantiate<V>();
      ev.decodeIntoVersioned(blob.subarray(off, off + len), ver);
      out.push(ev);
      off += len;
    }
    return out;
  }
}
