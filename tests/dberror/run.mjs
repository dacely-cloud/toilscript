// Compile a tiny ToilDB program and instantiate it against a host that returns
// each class of negative status. A read that returns `null` must be
// distinguishable: `null` + `DbError.None` is an absent row, `null` + anything
// else is a typed `TDLnnn` failure the guest can branch on.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "dberror-"));
const app = join(tmp, "app.ts");
const out = join(tmp, "out.wasm");

function fail(msg) {
    console.error(`DbError test suite: ${msg}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
}

writeFileSync(
    app,
    `
@data
class Key {
  id: string = "";
  constructor(id: string = "") { this.id = id; }
}

@data
class User {
  name: string = "";
}

@database
class App {
  @collection static users: Documents<Key, User>;
}

/// A read that misses returns null; the typed reason is Db.lastError().
export function readMiss(): i32 {
  const v = App.users.get(new Key("alice"));
  if (v != null) return -1;
  return <i32>Db.lastError();
}

/// The pure status decoder, across every band.
export function pureDecode(): i32 {
  if (Db.errorOf(0) != DbError.None) return -1;          // success
  if (Db.errorOf(7) != DbError.None) return -2;          // a stashed length
  if (Db.errorOf(-1) != DbError.None) return -3;         // buffer too small
  if (Db.errorOf(-2) != DbError.None) return -4;         // absent
  if (Db.errorOf(-1001) != DbError.InvalidHandle) return -5;
  if (Db.errorOf(-1002) != DbError.TenantMismatch) return -6;
  if (Db.errorOf(-1003) != DbError.AlreadyExists) return -7;
  if (Db.errorOf(-1004) != DbError.Conflict) return -8;
  if (Db.errorOf(-1006) != DbError.Codec) return -9;
  if (Db.errorOf(-1011) != DbError.OpNotAllowedInKind) return -10;
  if (Db.errorOf(-1021) != DbError.ByteBudget) return -11;
  if (Db.errorOf(-1025) != DbError.QuotaExceeded) return -12;
  if (Db.errorOf(-1030) != DbError.FillThrottled) return -13;
  if (Db.errorOf(-1031) != DbError.Unavailable) return -14;
  if (Db.errorOf(-1040) != DbError.HotPartition) return -15;
  if (Db.errorOf(-1041) != DbError.ColdStorm) return -16;
  if (Db.errorOf(-1070) != DbError.SchemaUnavailable) return -17;
  if (Db.errorOf(-1090) != DbError.CatalogOutsideAdmin) return -18;
  if (Db.errorOf(-1999) != DbError.Unknown) return -19;   // in-band, unknown code
  if (Db.errorOf(-3) != DbError.Unknown) return -20;      // below the sentinels
  return 0;
}

/// isRetryable is exactly the set of failures a read can actually hand back.
export function retryClassification(): i32 {
  if (Db.isRetryable(DbError.None)) return -1;
  if (!Db.isRetryable(DbError.FillThrottled)) return -2;
  if (!Db.isRetryable(DbError.Unavailable)) return -3;
  if (!Db.isRetryable(DbError.HotPartition)) return -4;
  if (!Db.isRetryable(DbError.ColdStorm)) return -5;
  // Hard faults trap, and are not retryable even when decoded from a raw status.
  if (Db.isRetryable(DbError.QuotaExceeded)) return -6;
  if (Db.isRetryable(DbError.Backend)) return -7;
  if (Db.isRetryable(DbError.Conflict)) return -8;
  if (Db.isRetryable(DbError.Unknown)) return -9;
  return 0;
}
`,
);

const compile = spawnSync(
    "node",
    [join(root, "bin", "toilscript.js"), app, "-o", out, "--runtime", "stub"],
    { stdio: "inherit" },
);
if (compile.status !== 0) fail("COMPILE FAILED");

let memory = null;
let getStatus = -2;
function readString(ptr) {
    if (!ptr || !memory) return "";
    const u32 = new Uint32Array(memory.buffer);
    const len = u32[(ptr - 4) >>> 2];
    const u16 = new Uint16Array(memory.buffer, ptr, len >>> 1);
    return String.fromCharCode.apply(null, u16);
}

const imports = {
    env: {
        abort(msgPtr, filePtr, line, col) {
            const msg = readString(msgPtr);
            const file = readString(filePtr);
            throw new Error(`abort ${file}:${line}:${col}${msg ? " (" + msg + ")" : ""}`);
        },
        "data.resolve_collection"(_namePtr, _nameLen, outHandlePtr) {
            new DataView(memory.buffer).setUint32(outHandlePtr, 1, true);
            return 0;
        },
        "data.get"() {
            return getStatus;
        },
        // Referenced by the compiled `get()` success path, which no case here takes.
        "data.take_result"() {
            throw new Error("BUG: take_result called after a negative status");
        },
        "data.result_schema_version"() {
            throw new Error("BUG: result_schema_version called after a negative status");
        },
    },
};

const wasm = readFileSync(out);
rmSync(tmp, { recursive: true, force: true });

// Any other host import the compiled program happens to declare is a hard error if
// reached: no case here should touch one, so a call means the guest took a path we
// did not intend to test.
for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(wasm))) {
    if (imp.module !== "env" || imp.kind !== "function") continue;
    if (imports.env[imp.name] === undefined) {
        imports.env[imp.name] = () => {
            throw new Error(`BUG: unexpected host call env.${imp.name}`);
        };
    }
}

const { instance } = await WebAssembly.instantiate(wasm, imports);
memory = instance.exports.memory;
const x = instance.exports;

let failures = 0;
const check = (name, got, want) => {
    const ok = got === want;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${got}, want ${want}`}`);
};

check("pure status decoder", x.pureDecode(), 0);
check("isRetryable classifies the returnable set", x.retryClassification(), 0);

// `-2` ABSENT is a normal miss, not a failure.
getStatus = -2;
check("absent row -> null + DbError.None", x.readMiss(), 0);

// The ONLY typed failures a read can hand back. Every other TDL code is a hard
// fault that traps the request host-side (toil-backend `status_is_hard_fault`), so
// a guest can never observe it and there is nothing here to assert about it.
getStatus = -1030;
check("TDL030 -> FillThrottled", x.readMiss(), 30);
getStatus = -1031;
check("TDL031 -> Unavailable", x.readMiss(), 31);
getStatus = -1040;
check("TDL040 -> HotPartition", x.readMiss(), 40);
getStatus = -1041;
check("TDL041 -> ColdStorm", x.readMiss(), 41);
getStatus = -1234;
check("unknown in-band code -> Unknown", x.readMiss(), -1);

// A later absent read must CLEAR the previous failure, not leave it stale.
getStatus = -2;
check("absent read clears the prior failure", x.readMiss(), 0);

console.log(failures === 0 ? "\nDbError test suite: ALL PASS" : `\nDbError: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
