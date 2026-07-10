// Compile tests/daemon/daemon.spec.ts with the local toilscript, instantiate it
// against a host that reimplements the toil-backend daemon ABI from the Rust
// source, and report. This covers two things a compiler test cannot:
//
//   1. the imports land in the `daemon` wasm MODULE with BARE names (production
//      registers `("daemon", "is_leader")`; a dotted `("env", "daemon.is_leader")`
//      resolves in a dev emulator and trap-stubs at the edge), and
//   2. the `http_call` request/response envelopes are byte-compatible with the
//      host framing, in both directions.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const spec = join(here, "daemon.spec.ts");
const tmp = mkdtempSync(join(tmpdir(), "daemontest-"));
const out = join(tmp, "spec.wasm");

const compile = spawnSync(
    "node",
    [join(root, "bin", "toilscript.js"), spec, "-o", out, "--runtime", "stub"],
    { stdio: "inherit" },
);
if (compile.status !== 0) {
    console.error("daemon test suite: COMPILE FAILED");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
}

const wasm = readFileSync(out);
rmSync(tmp, { recursive: true, force: true });

// --- the host half of the ABI (mirrored from toil-backend) -------------------

/** `daemon_err(c) = -(0x10000 + c)` (cold/imports.rs). */
const daemonErr = (code) => -(0x10000 + code);
const ERR_DAEMON_LEASE_LOST = 0x0402;
const ERR_DAEMON_CALL_FAILED = 0x0405;

let memory = null;
const bytes = () => new Uint8Array(memory.buffer);

/** Mirror of Rust `HttpRequest::decode`, little-endian throughout. */
function decodeRequest(ptr, len) {
    const b = bytes().subarray(ptr, ptr + len);
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const str = (o, n) => Buffer.from(b.subarray(o, o + n)).toString("utf8");
    let o = 0;
    const methodLen = b[o];
    o += 1;
    const method = str(o, methodLen);
    o += methodLen;
    const urlLen = d.getUint16(o, true);
    o += 2;
    const url = str(o, urlLen);
    o += urlLen;
    const nHeaders = d.getUint16(o, true);
    o += 2;
    const headers = [];
    for (let i = 0; i < nHeaders; i++) {
        const nl = d.getUint16(o, true);
        o += 2;
        const name = str(o, nl);
        o += nl;
        const vl = d.getUint16(o, true);
        o += 2;
        const val = str(o, vl);
        o += vl;
        headers.push([name, val]);
    }
    const bodyLen = d.getUint32(o, true);
    o += 4;
    const body = Buffer.from(b.subarray(o, o + bodyLen));
    o += bodyLen;
    if (o !== len) throw new Error(`request framing: consumed ${o} of ${len} bytes`);
    return { method, url, headers, body };
}

/** Mirror of Rust `HttpResponse::encode`, little-endian throughout. */
function encodeResponse({ status, headers, body }) {
    const u16 = (n) => {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(n);
        return b;
    };
    const u32 = (n) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n);
        return b;
    };
    const parts = [u16(status), u16(headers.length)];
    for (const [name, val] of headers) {
        const n = Buffer.from(name, "utf8");
        const v = Buffer.from(val, "utf8");
        parts.push(u16(n.length), n, u16(v.length), v);
    }
    const bd = Buffer.from(body);
    parts.push(u32(bd.length), bd);
    return Buffer.concat(parts);
}

let leader = true;
let observed = null;

const daemon = {
    is_leader: () => (leader ? 1 : 0),
    // EPOCH_NONE (-1) when this node does not hold the lease.
    current_epoch: () => (leader ? 7n : -1n),
    yield: () => (leader ? 0 : daemonErr(ERR_DAEMON_LEASE_LOST)),
    sleep_ms: (_ms) => (leader ? 0 : daemonErr(ERR_DAEMON_LEASE_LOST)),
    task_count: () => 3,
    next_fire_ms: (taskId) => (taskId === 0 ? 1234n : -1n),
    http_call: (reqPtr, reqLen, outPtr, outCap) => {
        const req = decodeRequest(reqPtr, reqLen);
        observed = req;

        if (req.url.includes("blocked.invalid")) return BigInt(daemonErr(ERR_DAEMON_CALL_FAILED));

        let enc;
        if (req.url.endsWith("/truncated")) {
            // Claim one more body byte than the envelope carries.
            const good = encodeResponse({ status: 200, headers: [], body: Buffer.from("ab") });
            good.writeUInt32LE(3, good.length - 2 - 4);
            enc = good;
        } else if (req.url === "https://example.com/") {
            enc = encodeResponse({ status: 204, headers: [], body: Buffer.alloc(0) });
        } else {
            enc = encodeResponse({
                status: 201,
                headers: [
                    ["x-a", "1"],
                    ["x-b", "2"],
                ],
                body: Buffer.from("hello", "utf8"),
            });
        }
        if (enc.length > outCap) return -1n; // STATUS_TOO_SMALL
        bytes().set(enc, outPtr);
        return BigInt(enc.length);
    },
};

const imports = {
    env: {
        abort(_msgPtr, _filePtr, line, col) {
            throw new Error(`guest abort at daemon.spec.ts:${line}:${col}`);
        },
    },
    daemon,
};

// --- 1. the import surface ---------------------------------------------------

let failures = 0;
const check = (name, got, want) => {
    const ok = got === want;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${got}, want ${want}`}`);
};

const declared = WebAssembly.Module.imports(new WebAssembly.Module(wasm))
    .filter((i) => i.module === "daemon")
    .map((i) => i.name)
    .sort();
check(
    "imports land in the `daemon` module with bare names",
    declared.join(","),
    "current_epoch,http_call,is_leader,next_fire_ms,sleep_ms,task_count,yield",
);
const dotted = WebAssembly.Module.imports(new WebAssembly.Module(wasm)).filter((i) =>
    i.name.startsWith("daemon."),
);
check("no dotted `env.daemon.*` imports", dotted.length, 0);

// --- 2. behavior -------------------------------------------------------------

const { instance } = await WebAssembly.instantiate(wasm, imports);
memory = instance.exports.memory;
const x = instance.exports;

check("roundtrip", x.roundtrip(), 0);
check("request method survives the wire", observed.method, "POST");
check("request url survives the wire", observed.url, "https://example.com/x");
check(
    "request headers survive the wire",
    JSON.stringify(observed.headers),
    JSON.stringify([
        ["content-type", "application/json"],
        ["x-req", "42"],
    ]),
);
check("request body survives the wire", observed.body.toString("utf8"), '{"a":1}');

check("minimal (no headers, empty body)", x.minimal(), 0);
check("tooSmall reports ResponseTooLarge", x.tooSmall(), -1);
check("callFailed decodes the bridged host code", x.callFailed(), 0x0405);
check("truncated response is refused (BadEnvelope)", x.truncatedResponse(), -2);

observed = null;
check("badEnvelope reports BadEnvelope", x.badEnvelope(), -2);
check("badEnvelope never reaches the wire", observed, null);

// The host caps `req_len` (the WHOLE envelope) and TRAPS when it is exceeded, so an
// over-cap request must never leave the guest.
observed = null;
check("oversize envelope refused (body fits, headers push it over)", x.oversizeEnvelope(), -2);
check("oversize envelope never reaches the wire", observed, null);

observed = null;
check("oversize body refused", x.oversizeBody(), -2);
check("oversize body never reaches the wire", observed, null);

check("an envelope exactly at the cap is allowed", x.maxEnvelopeAllowed(), 0);
check("max envelope req_len == 256 KiB", observed.body.length + 32, 256 * 1024);

check("leader introspection", x.leaderChecks(), 0);

leader = false;
check("lost lease surfaces as LeaseLost", x.leaseLost(), 0);
check("non-leader epoch is -1", x.epochNone(), 0);

console.log(
    failures === 0 ? "\ndaemon ABI + envelope: all cases passed" : `\ndaemon: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
