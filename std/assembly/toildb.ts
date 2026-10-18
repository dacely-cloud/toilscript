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

/// A typed ToilDB failure, the `TDLnnn` diagnostic of spec 27.1. The host bridges
/// one as `-(1000 + nnn)`; the two small sentinels are NOT failures (`-1` output
/// buffer too small, `-2` absent), so both decode to `None`.
///
/// Only a SUBSET can ever reach guest code. A hard fault (budget/quota, storage,
/// integrity, capability/schema) is indistinguishable from a benign outcome at the
/// ABI, so returning it would silently drop the op; the host TRAPS the request
/// instead and the guest never runs again (toil-backend `status_is_hard_fault`).
/// The members below say which is which. Every code is still listed, because
/// `Db.errorOf` decodes any raw status.
///
/// So after a read returns `null`, `Db.lastError()` is either `None` (the row is
/// absent) or one of the four RETRYABLE availability signals. `AlreadyExists` and
/// `Conflict` are write outcomes, not read ones.
@global
export enum DbError {
  /// No failure: the operation succeeded, or the row was simply absent.
  None = 0,
  /// TDL001: the collection handle is not one the host issued. HARD FAULT: traps.
  InvalidHandle = 1,
  /// TDL002: wrong tenant, or the row's MAC did not verify. HARD FAULT: traps.
  TenantMismatch = 2,
  /// TDL003: a `create` found the key already present. A write outcome.
  AlreadyExists = 3,
  /// TDL004: a compare-and-set lost, or a `@unique` value is owned elsewhere. A
  /// write outcome.
  Conflict = 4,
  /// TDL005: the operation is not supported here. HARD FAULT: traps.
  Unsupported = 5,
  /// TDL006: the value did not decode against its schema. HARD FAULT: traps.
  Codec = 6,
  /// TDL007: an internal storage failure. HARD FAULT: traps.
  Backend = 7,
  /// TDL010: the op does not exist for this collection family. HARD FAULT: traps.
  OpNotAllowedForFamily = 10,
  /// TDL011: the op is not allowed for this kind, or at this tier. HARD FAULT: traps.
  OpNotAllowedInKind = 11,
  /// TDL020: too many ops, or too many keys in one multi-op. HARD FAULT: traps.
  OpBudget = 20,
  /// TDL021: the request or its result exceeds the byte budget. HARD FAULT: traps.
  ByteBudget = 21,
  /// TDL022: the value nests too deeply. HARD FAULT: traps.
  DepthBudget = 22,
  /// TDL025: the tenant is over its plan quota. HARD FAULT: traps, so a guest can
  /// never observe this. It is here only to decode a raw status.
  QuotaExceeded = 25,
  /// TDL030: a backfill is throttling this read. RETRYABLE.
  FillThrottled = 30,
  /// TDL031: the home region, or the data, is temporarily unavailable. RETRYABLE.
  Unavailable = 31,
  /// TDL040: this key is a hot partition. RETRYABLE.
  HotPartition = 40,
  /// TDL041: too many cold reads at once. RETRYABLE.
  ColdStorm = 41,
  /// TDL070: the schema is temporarily unavailable. HARD FAULT: traps.
  SchemaUnavailable = 70,
  /// TDL090: a catalog op outside an admin context. HARD FAULT: traps.
  CatalogOutsideAdmin = 90,
  /// A negative status that carries no known `TDLnnn`.
  Unknown = -1,
}

/// The typed failure of the last read that returned `null`/empty. See `Db`.
// @ts-ignore: decorator
@lazy
var __toildbLastError: DbError = DbError.None;

/// Decode a raw host status into a typed failure. Non-negative, `-1` (buffer too
/// small) and `-2` (absent) are all `None`: only the `<= -1000` band is a failure.
function __toildbErrorOf(status: i32): DbError {
  if (status >= -2) return DbError.None;
  const code = -status - 1000;
  if (code < 0) return DbError.Unknown;
  switch (code) {
    case 1: return DbError.InvalidHandle;
    case 2: return DbError.TenantMismatch;
    case 3: return DbError.AlreadyExists;
    case 4: return DbError.Conflict;
    case 5: return DbError.Unsupported;
    case 6: return DbError.Codec;
    case 7: return DbError.Backend;
    case 10: return DbError.OpNotAllowedForFamily;
    case 11: return DbError.OpNotAllowedInKind;
    case 20: return DbError.OpBudget;
    case 21: return DbError.ByteBudget;
    case 22: return DbError.DepthBudget;
    case 25: return DbError.QuotaExceeded;
    case 30: return DbError.FillThrottled;
    case 31: return DbError.Unavailable;
    case 40: return DbError.HotPartition;
    case 41: return DbError.ColdStorm;
    case 70: return DbError.SchemaUnavailable;
    case 90: return DbError.CatalogOutsideAdmin;
    default: return DbError.Unknown;
  }
}

/// Record the outcome of a read that is about to return `null`. An absent row
/// records `None`, so `null` + `None` means "not found" and `null` + anything else
/// means "failed".
function __toildbMiss(status: i32): void {
  __toildbLastError = __toildbErrorOf(status);
}

/// A point-in-time snapshot; reading it consumes host gas, not a DB operation.
@global
export class DbBudget {
  constructor(public ops: u32, public writes: u32, public bytes: u32,
    public maxOps: u32, public maxWrites: u32, public maxBytes: u32,
    public maxResultBytes: u32) {}
  get remainingOps(): u32 { return this.ops >= this.maxOps ? 0 : this.maxOps - this.ops; }
  get remainingWrites(): u32 { return this.writes >= this.maxWrites ? 0 : this.maxWrites - this.writes; }
  get remainingBytes(): u32 { return this.bytes >= this.maxBytes ? 0 : this.maxBytes - this.bytes; }
}

/// ToilDB diagnostics. Read `lastError()` immediately after a read returns `null`
/// to tell an absent row from a failed one; the next read overwrites it.
///
/// ```ts
/// const u = App.users.get(id);
/// if (u == null && Db.isRetryable(Db.lastError())) {
///   // The row may well exist: the store is briefly unavailable. Retry or 503.
/// }
/// ```
///
/// `Documents.get`, `Documents.getDelete`, `View.get`, `Unique.lookup`,
/// `Events.get` and `Events.last`
/// record into this. Every other ToilDB op either succeeds or traps. The `Analytics`
/// reads also answer `null`, but on their own `-2 absent` / `-3 forbidden` statuses
/// rather than a `TDLnnn`, so they leave `lastError()` untouched: do not consult it
/// after one, or you will read a stale value from an earlier ToilDB read.
/// A conservative invalidation hint; a key can also have been read or retried.
@global
export class DbChange {
  constructor(public database: string, public collection: string, public key: Uint8Array) {}
}

@global
export class DbChanges {
  constructor(public fullRescan: bool, public keys: DbChange[]) {}
}

@global
export class Db {
  /// Begin an Action-only batch inside one explicit partition. All collections
  /// must be localOnly Documents in the same database. Use a stable token.
  static atomic<P>(partition: P, token: Uint8Array): AtomicBatch {
    return new AtomicBatch(partition.encode(), token);
  }
  /// Persist a request for another invocation by the resident cold scheduler.
  static continueDerive(): void {
    if (toildbHost.continueDerive() != 0) unreachable();
  }

  /// Explicit timed/startup materialization from a Job. Retains the Job budget.
  /// Use the @derive database/method names so events.since shares its checkpoint.
  static runDerive(database: string, method: string, body: () => void): void {
    const db = Uint8Array.wrap(String.UTF8.encode(database));
    const name = Uint8Array.wrap(String.UTF8.encode(method));
    if (toildbHost.beginDerive(db.dataStart, db.length, name.dataStart, name.length) != 0) unreachable();
    body();
    if (toildbHost.endDerive() != 0) unreachable();
  }

  /// Derive-only. Always handle fullRescan (startup, retries, overflow or remote writes).
  static changes(): DbChanges {
    const out = new Uint8Array(65536);
    const n = toildbHost.changes(out.dataStart, out.byteLength);
    if (n < 5 || n > out.byteLength) unreachable();
    const reader = new DataReader(out.subarray(0, n));
    const full = reader.readU8() != 0;
    const count = reader.readU32();
    if (count > 256) unreachable();
    const keys = new Array<DbChange>();
    for (let i:u32 = 0; i < count; i++) {
      keys.push(new DbChange(reader.readString(), reader.readString(), reader.readBytes()));
    }
    return new DbChanges(full, keys);
  }

  /// Includes framework calls and internal unique-field enforcement.
  static budget(): DbBudget {
    const out = new Uint8Array(28);
    if (toildbHost.budget(out.dataStart, out.byteLength) != 28) unreachable();
    return new DbBudget(load<u32>(out.dataStart), load<u32>(out.dataStart, 4),
      load<u32>(out.dataStart, 8), load<u32>(out.dataStart, 12), load<u32>(out.dataStart, 16),
      load<u32>(out.dataStart, 20), load<u32>(out.dataStart, 24));
  }

  /// The failure recorded by the most recent read that returned `null`. `None`
  /// when that read simply found nothing.
  static lastError(): DbError {
    return __toildbLastError;
  }

  /// Decode a raw negative host status into its typed failure.
  static errorOf(status: i32): DbError {
    return __toildbErrorOf(status);
  }

  /// Whether `err` is a transient availability signal, so the same read may well
  /// succeed later. These are the ONLY failures a read can hand back: everything
  /// else traps the request before the guest resumes.
  static isRetryable(err: DbError): bool {
    return (
      err == DbError.FillThrottled ||
      err == DbError.Unavailable ||
      err == DbError.HotPartition ||
      err == DbError.ColdStorm
    );
  }
}

/// A mutable keyed-entity collection (spec 7.1). `V` is the `@data` value type,
/// `K` the `@data` key type.
@global
/// The outcome of `Documents.upsert` (spec 8.3). The wire bytes are pinned in the
/// host ABI (`data.upsert`): a non-negative tag the guest returns as-is.
export enum UpsertResult {
  /// The row did not exist and was created.
  Created = 0,
  /// The row already existed and was overwritten.
  Updated = 1,
  /// A `@unique` field value is already owned by a DIFFERENT record; nothing was
  /// written (the only outcome an upsert cannot auto-resolve).
  Conflict = 2,
}

/// An observed value plus its original storage bytes (before decoding/migration).
/// Keep the snapshot unchanged while constructing a replacement value.
@global
export class DocumentSnapshot<V> {
  constructor(public value: V, public encoded: Uint8Array) {}
}

/// An exact observed document, suitable for conditional cleanup after a scan.
@global
export class DocumentEntry<K,V> {
  constructor(public key:K, public snapshot:DocumentSnapshot<V>, public encodedKey:Uint8Array) {}
  get value():V { return this.snapshot.value; }
}
@global
export class DocumentPage<K,V> {
  constructor(public entries:DocumentEntry<K,V>[], public cursor:Uint8Array|null) {}
}

@global
export class Documents<K, V> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /** A separate, explicitly partitioned namespace for atomic records. */
  partition<P>(key: P): AtomicDocuments<K, V> {
    return new AtomicDocuments<K, V>(this.__handle, key.encode());
  }

  /** @internal Opaque handle; the host still validates every capability. */
  __atomicHandle(): u32 { return this.__handle; }

  /// Bounded background scan of a complete local collection copy. Empty pages
  /// can have a cursor. Reuse it until null; concurrent writes are not a snapshot.
  scan(limit:i32,cursor:Uint8Array|null=null):DocumentPage<K,V> {
    const cb=cursor==null?new Uint8Array(0):cursor;
    const status=toildbHost.documentsScan(this.__handle,cb.dataStart,cursor==null?-1:cb.byteLength,limit);
    if(status<0) abort("ToilDB documents.scan failed: status "+status.toString(),"toildb",0,0);
    const bytes=__toildbTake(status);
    const reader=new DataReader(bytes);
    const count=reader.readU32();
    const entries=new Array<DocumentEntry<K,V>>();
    for(let i:u32=0;i<count;i++) {
      const kb=reader.readBytes();const version=reader.readU32();const vb=reader.readBytes();
      const key=instantiate<K>();key.decodeInto(kb);
      const value=instantiate<V>();value.decodeIntoVersioned(vb,<i64>version);
      entries.push(new DocumentEntry<K,V>(key,new DocumentSnapshot<V>(value,vb),kb));
    }
    let next:Uint8Array|null=null;
    if(reader.readU8()!=0) next=reader.readBytes();
    return new DocumentPage<K,V>(entries,next);
  }

  /// Return the record, or `null` if it does not exist.
  get(key: K): V | null {
    const kb = key.encode();
    const status = toildbHost.get(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) { __toildbMiss(status); return null; }
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

  /// Read without rewrite-on-read. Retains the exact bytes for conditional writes,
  /// including records whose codec or schema migrated during decoding.
  getSnapshot(key: K): DocumentSnapshot<V> | null {
    const kb = key.encode();
    const status = toildbHost.get(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) { __toildbMiss(status); return null; }
    const bytes = __toildbTake(status);
    const value = instantiate<V>();
    value.decodeInto(bytes);
    return new DocumentSnapshot<V>(value, bytes);
  }

  /// Owner-authoritative snapshot, bypassing replica and request caches.
  getCurrentSnapshot(key: K): DocumentSnapshot<V> | null {
    const kb = key.encode();
    const status = toildbHost.getCurrent(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) { __toildbMiss(status); return null; }
    const bytes = __toildbTake(status);
    const value = instantiate<V>();
    value.decodeInto(bytes);
    return new DocumentSnapshot<V>(value, bytes);
  }

  compareExchangeSnapshot(key: K, expected: DocumentSnapshot<V> | null, value: V): bool {
    const kb = key.encode();
    const vb = value.encode();
    const eb = expected == null ? new Uint8Array(0) : expected.encoded;
    const status = toildbHost.compareExchange(this.__handle, kb.dataStart, kb.byteLength,
      eb.dataStart, expected == null ? -1 : eb.byteLength, vb.dataStart, vb.byteLength);
    if (status < 0) abort("ToilDB compareExchange failed: status " + status.toString(), "toildb", 0, 0);
    return status == 1;
  }

  compareDeleteSnapshot(key: K, expected: DocumentSnapshot<V>): bool {
    const kb = key.encode();
    const eb = expected.encoded;
    const status = toildbHost.compareDelete(this.__handle, kb.dataStart, kb.byteLength, eb.dataStart, eb.byteLength);
    if (status < 0) abort("ToilDB compareDelete failed: status " + status.toString(), "toildb", 0, 0);
    return status == 1;
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
    if (status < 0) {
      __toildbMiss(status);
      abort("ToilDB getMany failed: status " + status.toString() +
        "; DbError=" + (<i32>Db.lastError()).toString() +
        "; keys=" + keys.length.toString() +
        ". Query accepts 32 keys, Action 64, background 1024; split larger batches.", "toildb", 0, 0);
    }
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

  /// Create-or-overwrite in ONE op (spec 8.3): a blind last-writer-wins put that
  /// creates the row if absent or overwrites it if present, replacing the two-op
  /// `if (!create(k,v)) patch(k,v)` idiom. Returns `UpsertResult.Created` or
  /// `.Updated`; on a `@unique` collection, `.Conflict` when the value's unique
  /// field is already held by ANOTHER record (nothing is written).
  ///
  /// The write is blind: it stores `value` as-is, so concurrent upserts do not
  /// conflict or retry - the later one wins and overwrites the earlier. Correct
  /// for writing a whole value (a profile, a settings blob); wrong for a
  /// read-modify-write of accumulating state (a balance, a like count), where a
  /// concurrent write would be lost - use `counter.add` or a caller-observed
  /// conditional write there. A lost write is a data-integrity concern, not a
  /// boundary one:
  /// the key is tenant-scoped, so a race is only ever one tenant's own concurrent
  /// writes, and `@unique` stays race-safe (claim-once at the value's home).
  upsert(key: K, value: V): UpsertResult {
    const kb = key.encode();
    const vb = value.encode();
    const status = toildbHost.upsert(
      this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0
    );
    if (status < 0) unreachable();
    return <UpsertResult>status;
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

  /// Replace only if the stored bytes equal `expected`; null expects absence.
  /// Returns false on a mismatch. Routed to the owner; @unique values are rejected.
  compareExchange(key: K, expected: V | null, value: V): bool {
    const kb = key.encode();
    const vb = value.encode();
    const eb = expected == null ? new Uint8Array(0) : expected.encode();
    const status = toildbHost.compareExchange(
      this.__handle, kb.dataStart, kb.byteLength,
      eb.dataStart, expected == null ? -1 : eb.byteLength,
      vb.dataStart, vb.byteLength
    );
    if (status < 0) abort("ToilDB compareExchange failed: status " + status.toString(), "toildb", 0, 0);
    return status == 1;
  }

  /// Submit a replacement of an EXISTING record: true when accepted, false on
  /// absence or rejection. The ABI carries no caller-observed version or value,
  /// so this cannot protect a read-modify-write based on an earlier application read.
  enqueue(key: K, value: V): bool {
    const kb = key.encode();
    const vb = value.encode();
    return toildbHost.enqueue(this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0) == 0;
  }

  /// Delete only when the stored bytes still equal the caller's expectation.
  compareDelete(key: K, expected: V): bool {
    return this.compareDeleteSnapshot(key, new DocumentSnapshot<V>(expected, expected.encode()));
  }

  /// Delete the record (idempotent).
  delete(key: K): void {
    const kb = key.encode();
    const status = toildbHost.del(this.__handle, kb.dataStart, kb.byteLength, 0);
    if (status < 0) abort("ToilDB delete failed: status " + status.toString(), "toildb", 0, 0);
  }

  /// Atomic fetch-and-delete (consume-once); returns the prior value or `null`.
  getDelete(key: K): V | null {
    const kb = key.encode();
    const status = toildbHost.getDelete(this.__handle, kb.dataStart, kb.byteLength, 0);
    if (status < 0) { __toildbMiss(status); return null; }
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
    if (status < 0) { __toildbMiss(status); return null; }
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

  /// Remove a projection key. Delete its source personal data before rebuilding.
  delete(key: K): void {
    const kb = key.encode();
    const status = toildbHost.viewDelete(this.__handle, kb.dataStart, kb.byteLength, 0);
    if (status < 0) abort("ToilDB view.delete failed: status " + status.toString(), "toildb", 0, 0);
  }

  /// Publish (overwrite) the view for `key`. Derive/job only; the host assigns
  /// the version so a later publish always supersedes an earlier one.
  publish(key: K, value: V): void {
    const kb = key.encode();
    const vb = value.encode();
    const status = toildbHost.viewPublish(
      this.__handle, kb.dataStart, kb.byteLength, vb.dataStart, vb.byteLength, 0
    );
    if (status < 0) abort("ToilDB view.publish failed: status " + status.toString(), "toildb", 0, 0);
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
    if (status < 0) { __toildbMiss(status); return null; }
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    return v;
  }

  /// Bounded owner lookup in input order, with null for each unclaimed key.
  /// Uses one read operation; the host enforces the per-request batch limit.
  lookupMany(keys: K[]): Array<V | null> {
    return new Documents<K, V>(this.__handle).getMany(keys);
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

/// A page in encoded-member order; pass cursor to listPage to continue.
@global
export class MembershipPage<M> {
  members: M[];
  cursor: Uint8Array | null;
  constructor(members: M[], cursor: Uint8Array | null) {
    this.members = members;
    this.cursor = cursor;
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
    const status = toildbHost.membershipAdd(
      this.__handle, kb.dataStart, kb.byteLength, mb.dataStart, mb.byteLength, 0
    );
    if (status < 0) abort("ToilDB membership.add failed: status " + status.toString(), "toildb", 0, 0);
  }

  /// Remove `member` from the set (idempotent).
  remove(key: K, member: M): void {
    const kb = key.encode();
    const mb = member.encode();
    const status = toildbHost.membershipRemove(
      this.__handle, kb.dataStart, kb.byteLength, mb.dataStart, mb.byteLength, 0
    );
    if (status < 0) abort("ToilDB membership.remove failed: status " + status.toString(), "toildb", 0, 0);
  }

  /// Read members strictly after an opaque cursor. A full page may require an
  /// empty final page to establish the end. Pagination is not a snapshot.
  listPage(key: K, limit: i32, cursor: Uint8Array | null = null): MembershipPage<M> {
    const kb = key.encode();
    const cb = cursor == null ? new Uint8Array(0) : cursor;
    const status = toildbHost.membershipPage(
      this.__handle, kb.dataStart, kb.byteLength, cb.dataStart,
      cursor == null ? -1 : cb.byteLength, limit
    );
    if (status < 0) abort("ToilDB membership.listPage failed: status " + status.toString(), "toildb", 0, 0);
    const blob = __toildbTake(status);
    const out = new Array<M>();
    let off: i32 = 4;
    const count = load<u32>(blob.dataStart);
    for (let i: u32 = 0; i < count; i++) {
      const version = <i64>load<u32>(blob.dataStart + off); off += 4;
      const len = <i32>load<u32>(blob.dataStart + off); off += 4;
      const member = instantiate<M>();
      member.decodeIntoVersioned(blob.subarray(off, off + len), version);
      out.push(member); off += len;
    }
    const hasCursor = load<u8>(blob.dataStart + off); off++;
    let next: Uint8Array | null = null;
    if (hasCursor != 0) {
      const len = <i32>load<u32>(blob.dataStart + off); off += 4;
      next = blob.slice(off, off + len);
    }
    return new MembershipPage<M>(out, next);
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

/// A query-readable ordered index. Order keys compare by UTF-8 bytes; equal
/// order keys compare by encoded value bytes. Index stable IDs and fetch their
/// documents separately when values may change. Remove the old entry to reindex.
@global
export class SortedIndex<K, V> {
  private members: Membership<K, SortedIndexMember<V>>;
  constructor(handle: u32) { this.members = new Membership<K, SortedIndexMember<V>>(handle); }
  add(key: K, order: string, value: V): void {
    this.members.add(key, new SortedIndexMember<V>(order, value));
  }
  remove(key: K, order: string, value: V): void {
    this.members.remove(key, new SortedIndexMember<V>(order, value));
  }
  /// One bounded read: Query <=32, Action <=64, background <=1024 items.
  /// Cursors are exclusive. Concurrent writes may change later pages.
  page(key: K, limit: i32, cursor: Uint8Array | null = null): SortedIndexPage<V> {
    const page = this.members.listPage(key, limit, cursor);
    const values = new Array<V>();
    for (let i = 0; i < page.members.length; i++) values.push(page.members[i].value);
    return new SortedIndexPage<V>(values, page.cursor);
  }
}

@global
export class SortedIndexPage<V> {
  constructor(public items: V[], public cursor: Uint8Array | null) {}
}

/// Sortable unsigned numeric keys; fixed width preserves numeric order.
@global
export class SortKey {
  static u64(value: u64): string { return value.toString(16).padStart(16, '0'); }
  static descendingU64(value: u64): string { return SortKey.u64(u64.MAX_VALUE - value); }
}

// Order bytes precede the payload. Escaped NUL and a double-NUL terminator
// preserve lexical ordering, including prefix strings and embedded NULs.
class SortedIndexMember<V> {
  order: string;
  value: V;
  constructor(order: string = '', value: V = instantiate<V>()) { this.order = order; this.value = value; }
  encode(): Uint8Array {
    const order = Uint8Array.wrap(String.UTF8.encode(this.order));
    const value = this.value.encode();
    let size = order.length + 2 + value.length;
    for (let i = 0; i < order.length; i++) if (order[i] == 0) size++;
    const out = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < order.length; i++) {
      out[offset++] = order[i];
      if (order[i] == 0) out[offset++] = 255;
    }
    offset += 2;
    out.set(value, offset);
    return out;
  }
  decodeIntoVersioned(bytes: Uint8Array, version: i64): void {
    let offset = 0;
    let found = false;
    while (offset < bytes.length) {
      if (bytes[offset++] != 0) continue;
      if (offset >= bytes.length) unreachable();
      const next = bytes[offset++];
      if (next == 0) { found = true; break; }
      if (next != 255) unreachable();
    }
    if (!found) unreachable();
    this.value = instantiate<V>();
    this.value.decodeIntoVersioned(bytes.subarray(offset), version);
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
/// time-series. Ids `0..=41` are cumulative COUNTERS (a rate is `value / seconds`); `42..=45` are the
/// avg/peak series of the two GAUGES (ConnectedStreams, CommittedMemory). Append-only: never renumber.
export enum MetricId {
  Requests = 0,
  BytesOutL1 = 1,
  BytesInL1 = 2,
  Status2xx = 3,
  Status3xx = 4,
  Status4xx = 5,
  Status5xx = 6,
  StaticHits = 7,
  ExecutorFullRejects = 8,
  UnknownHostRejects = 9,
  RateLimitedRejects = 10,
  GasUsed = 11,
  DbOps = 12,
  DbReads = 13,
  DbWrites = 14,
  DbErrors = 15,
  DbLatencyNsSum = 16,
  StreamAccepts = 17,
  StreamRejectWrongNode = 18,
  StreamRejectCapacity = 19,
  StreamRejectArtifact = 20,
  StreamRejectGuest = 21,
  StreamTraps = 22,
  StreamIdleTimeouts = 23,
  StreamBytesIn = 24,
  StreamBytesOut = 25,
  StreamBackpressureEvents = 26,
  StreamCloses = 27,
  StreamDisconnects = 28,
  DaemonStarts = 29,
  DaemonStartFailures = 30,
  DaemonTicksFired = 31,
  DaemonTicksSkippedNotLeader = 32,
  DaemonTicksFailed = 33,
  DaemonLeaderAcquires = 34,
  DaemonLeaderFenced = 35,
  DaemonHttpCallAttempts = 36,
  DaemonHttpCallFailures = 37,
  MemGrownBytes = 38,
  Emails = 39,
  CacheHits = 40,
  CacheMisses = 41,
  ConnectedStreamsAvg = 42,
  ConnectedStreamsPeak = 43,
  CommittedMemoryAvg = 44,
  CommittedMemoryPeak = 45,
}

/// The number of cumulative counter metrics (`MetricId 0..=41`) = the length of the snapshot's lifetime
/// section.
export const METRIC_COUNTERS: i32 = 42;

/// The sustained-rate window (seconds): requests are metered over a 3-minute ROLLING window. A plan's
/// sustained request rate `X` (rps) permits `X * BURST_WINDOW_SECS` requests across it. Instantaneous
/// spikes ABOVE the sustained rate are NOT tier-capped (only the box firewall's global pps ceiling, the
/// DDoS backstop, applies); throttling (HTTP 429) begins only once the window's allowance is spent.
/// The window slides continuously rather than resetting on a boundary, so a spend does not become free
/// all at once: it ages out gradually over the following 3 minutes.
export const BURST_WINDOW_SECS: i32 = 180;

/// A dashboard time range for `Analytics.series`. Short ranges (1h/6h) read the per-MINUTE ring; the long
/// ranges (60d/90d) read the per-DAY ring (90-day retention); the rest read the per-HOUR ring (30-day).
/// Append-only: never renumber (D60/D90 were added after D30, keeping the wire ids stable).
export enum AnalyticsRange {
  H1 = 0,
  H6 = 1,
  H12 = 2,
  H24 = 3,
  D3 = 4,
  D7 = 5,
  D14 = 6,
  D30 = 7,
  D60 = 8,
  D90 = 9,
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
  /// Request meters (fleet-global, across every edge location) against the plan (cap 0 = unmetered).
  /// Burst: requests in the trailing 3-minute ROLLING window vs its allowance
  /// (`sustained_rps * BURST_WINDOW_SECS`). 30d: requests in the current 30-day bucket vs the quota
  /// (the quota still tumbles: it is a billing period, not a rate).
  reqBurstUsed: u64 = 0;
  reqBurstCap: u64 = 0;
  req30dUsed: u64 = 0;
  req30dCap: u64 = 0;
  /// LIVE per-second gauges (rates), computed edge-side from the last completed minute bucket so the
  /// guest is STATELESS (no client diffing of two snapshots). Idle -> 0.0. `f64` (a rate is fractional
  /// and bounded; f64 cannot overflow for any real value).
  rps: f64 = 0;
  bytesInPerSec: f64 = 0;
  bytesOutPerSec: f64 = 0;
  streamBytesInPerSec: f64 = 0;
  streamBytesOutPerSec: f64 = 0;
  dbOpsPerSec: f64 = 0;
  gasPerSec: f64 = 0;
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

  /// The plan's SUSTAINED request rate (requests/second), derived from the 3-minute burst cap
  /// (`reqBurstCap / BURST_WINDOW_SECS`). 0.0 means unmetered. Spikes above this rate are allowed;
  /// throttling only starts once `reqBurstUsed` passes `reqBurstCap` in the current bucket.
  get sustainedRpsCap(): f64 {
    return this.reqBurstCap == 0 ? 0.0 : <f64>this.reqBurstCap / <f64>BURST_WINDOW_SECS;
  }
}

/// One metric's time series for a range: `points` oldest→newest (per-bucket totals, `u64` — non-negative),
/// `bucketSecs` the per-bucket width, and `headMs` the newest bucket's end. Rates are derived, never stored.
export class Series {
  metric: MetricId = MetricId.Requests;
  bucketSecs: u32 = 0;
  headMs: u64 = 0;
  points: u64[] = [];

  /// Per-second rate of bucket `i` (its total divided by the bucket width). 0 for an out-of-range index.
  ratePerSec(i: i32): f64 {
    if (i < 0 || i >= this.points.length || this.bucketSecs == 0) return 0;
    return <f64>this.points[i] / <f64>this.bucketSecs;
  }

  /// The CUMULATIVE total over the whole window (e.g. total bytes across a 30d/90d range). Folded into an
  /// `f64` accumulator — NEVER a `u64`/`i64` sum, which could overflow a long byte-count window (AS has no
  /// u128; `f64` max is 1.8e308, so it cannot overflow for any real value).
  sum(): f64 {
    let acc: f64 = 0;
    for (let i = 0; i < this.points.length; i++) acc += <f64>this.points[i];
    return acc;
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
    if (version < 3) return stats; // pre-v3 edge: refuse rather than mis-decode (clean break, no v2)
    stats.nowMs = r.readU64();
    const count = <i32>r.readU32();
    for (let i: i32 = 0; i < count && r.ok; i++) {
      // Wire fields are non-negative i64; read the same bytes as u64.
      const v = r.readU64();
      if (i < METRIC_COUNTERS) stats.life[i] = v; // ignore any extra (forward-compat)
    }
    stats.connectedStreams = r.readU64();
    stats.committedMemory = r.readU64();
    stats.reqBurstUsed = r.readU64();
    stats.reqBurstCap = r.readU64();
    stats.req30dUsed = r.readU64();
    stats.req30dCap = r.readU64();
    // LIVE per-second rates (f64), appended after the windows. VERSION-GATE by LENGTH: a pre-rates
    // (shorter) frame from an older edge exhausts the buffer here, so `readF64` returns 0.0 for each
    // missing rate (DataReader is bounds-checked). No frame-version bump needed.
    stats.rps = r.readF64();
    stats.bytesInPerSec = r.readF64();
    stats.bytesOutPerSec = r.readF64();
    stats.streamBytesInPerSec = r.readF64();
    stats.streamBytesOutPerSec = r.readF64();
    stats.dbOpsPerSec = r.readF64();
    stats.gasPerSec = r.readF64();
    return stats;
  }

  private static decodeSeries(buf: Uint8Array): Series {
    const r = new DataReader(buf);
    const out = new Series();
    const version = r.readU16();
    if (version < 3) return out; // pre-v3 edge: refuse rather than mis-decode (clean break, no v2)
    out.metric = <MetricId>r.readU16();
    out.bucketSecs = r.readU32();
    out.headMs = r.readU64();
    const count = <i32>r.readU32();
    // Points are non-negative per-bucket totals: read as u64 (matches the edge `u64 LE` series frame).
    const pts = new Array<u64>(count);
    for (let i: i32 = 0; i < count && r.ok; i++) pts[i] = r.readU64();
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
export class EventRef {
  constructor(public sequence: u64 = 0, public hlc: u64 = 0) {}
}

@global
export class EventEntry<V> {
  constructor(public reference: EventRef, public value: V) {}
}

@global
export class EventPage<V> {
  constructor(public entries: Array<EventEntry<V>>, public cursor: u64, public hasMore: bool) {}
}

@global
export class Events<K, V> {
  private __handle: u32;

  constructor(handle: u32) {
    this.__handle = handle;
  }

  /// Read an appendOnce reference, including during pending cleanup. No payload is returned.
  reference(key: K, eventId: string): EventRef | null {
    const kb = key.encode();
    const id = Uint8Array.wrap(String.UTF8.encode(eventId));
    const status = toildbHost.eventsReference(this.__handle, kb.dataStart, kb.byteLength, id.dataStart, id.byteLength);
    if (status < 0) { __toildbMiss(status); return null; }
    const reader = new DataReader(__toildbTake(status));
    const reference = new EventRef(reader.readU64(), reader.readU64());
    if (!reader.ok) abort("Invalid event reference", "toildb", 0, 0);
    return reference;
  }

  /// Erase this entry and one bounded page of recovery copies. Repeat in later
  /// background calls until true. The payload is hidden from the first successful call.
  redact(key: K, reference: EventRef): bool {
    const kb = key.encode();
    const status = toildbHost.eventsRedact(this.__handle, kb.dataStart, kb.byteLength, reference.sequence, reference.hlc);
    if (status < 0) abort("ToilDB events.redact failed: status " + status.toString(), "toildb", 0, 0);
    return status == 1;
  }

  /// Bounded, oldest-first page with references for ordinary and appendOnce events.
  /// Keep the opaque cursor and use hasMore even if an erased page is empty.
  entries(key: K, limit: i32 = 128, after: u64 = 0): EventPage<V> {
    const kb = key.encode();
    const status = toildbHost.eventsEntries(this.__handle, kb.dataStart, kb.byteLength, limit, after);
    if (status < 0) abort("ToilDB events.entries failed: status " + status.toString(), "toildb", 0, 0);
    const reader = new DataReader(__toildbTake(status));
    const count = reader.readU32();
    const entries = new Array<EventEntry<V>>();
    for (let i: u32 = 0; i < count; i++) {
      const reference = new EventRef(reader.readU64(), reader.readU64());
      const version = <i64>reader.readU32();
      const bytes = reader.readBytes();
      const value = instantiate<V>(); value.decodeIntoVersioned(bytes, version);
      entries.push(new EventEntry<V>(reference, value));
    }
    const hasMore = reader.readU8() != 0;
    const cursor: u64 = hasMore ? reader.readU64() : 0;
    if (!reader.ok) abort("Invalid event page", "toildb", 0, 0);
    return new EventPage<V>(entries, cursor, hasMore);
  }

  /// Read an event by its appendOnce eventId, or null if absent. Bounded request-path read.
  get(key: K, eventId: string): V | null {
    const kb = key.encode();
    const idb = Uint8Array.wrap(String.UTF8.encode(eventId));
    const status = toildbHost.eventsGet(this.__handle, kb.dataStart, kb.byteLength, idb.dataStart, idb.byteLength);
    if (status < 0) { __toildbMiss(status); return null; }
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    return v;
  }

  /// Read the newest appended event, or null for an empty stream. Does not scan.
  last(key: K): V | null {
    const kb = key.encode();
    const status = toildbHost.eventsLast(this.__handle, kb.dataStart, kb.byteLength);
    if (status < 0) { __toildbMiss(status); return null; }
    const v = instantiate<V>();
    v.decodeInto(__toildbTake(status));
    return v;
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

  /// The NEXT batch of events for `key` past this derive's checkpoint, OLDEST first, up to `limit`. The
  /// host owns the resumable cursor (seeded from the durable checkpoint and advanced/committed around the
  /// fold), so repeated calls drain an unbounded log in bounded batches and return an empty array once
  /// caught up. Use it in a `@derive` (or `@job`) to fold a growing log incrementally instead of rescanning:
  /// `for (const e of this.events.since(key, 500)) { ...update the view... }`, looping until it is empty.
  /// The fold must be idempotent per event (a heal can trigger a full re-read). Same frame as `latest`.
  since(key: K, limit: i32): V[] {
    const kb = key.encode();
    const status = toildbHost.eventsSince(this.__handle, kb.dataStart, kb.byteLength, limit);
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

@global
export class AtomicDocuments<K, V> {
  constructor(private handle: u32, private partitionKey: Uint8Array) {}
  getSnapshot(key: K): DocumentSnapshot<V> | null {
    const kb=key.encode();
    const n=toildbHost.atomicGet(this.handle,this.partitionKey.dataStart,this.partitionKey.length,kb.dataStart,kb.length);
    if(n<0){__toildbMiss(n);return null;}
    const bytes=__toildbTake(n);const value=instantiate<V>();value.decodeInto(bytes);
    return new DocumentSnapshot<V>(value,bytes);
  }
  get(key: K): V | null {const snapshot=this.getSnapshot(key);return snapshot==null?null:snapshot.value;}
  require(key: K): V {const value=this.get(key);if(value==null)abort('Atomic document missing','toildb',0,0);return value;}
}
class AtomicBatchEntry {
  constructor(public handle:u32,public key:Uint8Array,public expected:Uint8Array|null,public value:Uint8Array|null) {}
}
@global
export class AtomicBatch {
  private entries:AtomicBatchEntry[]=new Array<AtomicBatchEntry>();
  private partitionKey:Uint8Array;
  private token:Uint8Array;
  constructor(partitionKey:Uint8Array,token:Uint8Array) {
    if(partitionKey.length<1||partitionKey.length>512||token.length<16||token.length>64)
      abort('Atomic partition or token length','toildb',0,0);
    this.partitionKey=partitionKey.slice();this.token=token.slice();
  }
  private add(entry:AtomicBatchEntry):AtomicBatch {
    if(this.entries.length>=16)abort('Atomic batch has more than 16 records','toildb',0,0);
    this.entries.push(entry);return this;
  }
  create<K,V>(collection:Documents<K,V>,key:K,value:V):AtomicBatch {
    return this.add(new AtomicBatchEntry(collection.__atomicHandle(),key.encode(),null,value.encode()));
  }
  compareExchange<K,V>(collection:Documents<K,V>,key:K,expected:DocumentSnapshot<V>|null,value:V):AtomicBatch {
    return this.add(new AtomicBatchEntry(collection.__atomicHandle(),key.encode(),expected==null?null:expected.encoded.slice(),value.encode()));
  }
  compareDelete<K,V>(collection:Documents<K,V>,key:K,expected:DocumentSnapshot<V>):AtomicBatch {
    return this.add(new AtomicBatchEntry(collection.__atomicHandle(),key.encode(),expected.encoded.slice(),null));
  }
  commit():bool {
    if(this.entries.length==0)abort('Atomic batch is empty','toildb',0,0);
    const w=new DataWriter();w.writeU8(1);w.writeBytes(this.partitionKey);w.writeBytes(this.token);w.writeU32(this.entries.length);
    for(let i=0;i<this.entries.length;i++) {
      const entry=this.entries[i];w.writeU32(entry.handle);w.writeBytes(entry.key);
      const expected=entry.expected;w.writeBool(expected!=null);if(expected!=null)w.writeBytes(expected);
      const value=entry.value;w.writeBool(value!=null);if(value!=null)w.writeBytes(value);
    }
    const frame=w.toBytes();if(frame.length>132*1024)abort('Atomic batch input limit','toildb',0,0);
    const status=toildbHost.atomicBatch(frame.dataStart,frame.length);
    if(status<0)abort('Atomic batch failed: '+status.toString(),'toildb',0,0);
    return status==1;
  }
}
