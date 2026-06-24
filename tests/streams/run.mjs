// Front-end gating tests for the streams + daemon decorators (spec 03 phase 0).
// Compiles small fixtures with the local toilscript under an explicit --targetMode
// and asserts on the exit status and the emitted diagnostic identifiers. This is the
// FIRST increment: AST kinds, DecoratorFlags bits, the hot/cold target mode, and the
// decorator gating. Codegen / catalog emission are later increments and not exercised.
import { mkdtempSync, writeFileSync, rmSync, openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const bin = join(root, "bin", "toilscript.js");

let failures = 0;

// Compile `source` under the given mode ("hot"/"cold"/null) and return { status, output }.
function compile(source, mode) {
    const tmp = mkdtempSync(join(tmpdir(), "streams-"));
    const app = join(tmp, "app.ts");
    const out = join(tmp, "out.wasm");
    const log = join(tmp, "compile.log");
    writeFileSync(app, source);
    const args = [bin, app, "-o", out, "--runtime", "stub"];
    if (mode != null) args.push("--targetMode", mode);
    const logFd = openSync(log, "w");
    const r = spawnSync("node", ["--enable-source-maps", ...args], {
        stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    const output = readFileSync(log, "utf8");
    rmSync(tmp, { recursive: true, force: true });
    return { status: r.status, output };
}

// Assert the compile SUCCEEDS (exit 0).
function expectPass(name, source, mode) {
    const { status, output } = compile(source, mode);
    if (status === 0) {
        console.log(`  ok   ${name}`);
    } else {
        failures++;
        console.error(`  FAIL ${name}: expected success, got status ${status}\n${output}`);
    }
}

// Assert the compile FAILS (non-zero) and the output contains `needle`.
function expectFail(name, source, mode, needle) {
    const { status, output } = compile(source, mode);
    if (status !== 0 && output.includes(needle)) {
        console.log(`  ok   ${name}`);
    } else {
        failures++;
        console.error(`  FAIL ${name}: expected failure containing '${needle}', got status ${status}\n${output}`);
    }
}

console.log("streams + daemon gating (spec 03 phase 0):");

// --- should-pass cases -------------------------------------------------------

// A valid @daemon with a @scheduled method compiles in cold mode.
expectPass("cold: @daemon + @scheduled", `
@daemon
class Jobs {
  @scheduled("30s") tick(): void {}
}
export function probe(): i32 { return 1; }
`, "cold");

// A valid @stream class with a lifecycle hook compiles in hot mode.
expectPass("hot: @stream + @message hook", `
@stream
class Chat {
  @message onMessage(): void {}
}
export function probe(): i32 { return 1; }
`, "hot");

// A @stream project with no @service/@remote compiles in hot mode.
expectPass("hot: @stream without service/remote", `
@stream
class Chat { @connect onConnect(): void {} }
export function probe(): i32 { return 1; }
`, "hot");

// The raw-bytes message bridge: a @message taking a StreamPacket and returning a StreamOutbound
// compiles (the injected ingress/egress ring runtime + the StreamPacket reader + StreamOutbound
// encoder, spec 03 section 3.4 / 5.1). A reject() / empty() must also type-check.
expectPass("hot: raw @message StreamPacket -> StreamOutbound bridge", `
@stream
class Echo {
  @message reply(p: StreamPacket): StreamOutbound { return StreamOutbound.reply(p.bytes()); }
  @connect onConnect(): void {}
}
export function probe(): i32 { return 1; }
`, "hot");

// The @connect bridge: a @connect taking a StreamInbound (the host-written connect-context view:
// streamId/transport/authority/path) and returning a StreamOutbound accept/reject compiles (the
// injected info block + StreamInbound reader, spec 05 4.4). accept()/reject() must type-check.
expectPass("hot: @connect StreamInbound -> StreamOutbound bridge", `
@stream
class Gate {
  @connect onConnect(c: StreamInbound): StreamOutbound {
    if (c.path() == "/blocked") return StreamOutbound.reject(0x0208);
    return StreamOutbound.accept();
  }
  @message onMessage(): void {}
}
export function probe(): i32 { return 1; }
`, "hot");

// E (audit): a ZERO-ARG @connect that returns a StreamOutbound is bridged - its accept/reject is
// honored (not discarded as a no-op accept). Compiles; the dispatch emits .__encode() on the return.
expectPass("hot: zero-arg @connect returning StreamOutbound is honored", `
@stream
class Gate {
  @connect onConnect(): StreamOutbound { return StreamOutbound.reject(0x0208); }
  @message onMessage(): void {}
}
export function probe(): i32 { return 1; }
`, "hot");

// Default request mode: an existing @rest controller compiles under null target mode.
expectPass("default request: @rest controller still compiles", `
@data
class Pong { msg: string = "pong"; }
@rest
class Api { @get ping(): Pong { return new Pong(); } }
export function probe(): i32 { return 1; }
`, null);

// --- should-fail cases -------------------------------------------------------

// D (audit): a @connect with an INVALID signature (here a StreamInbound param but a void return -
// the author forgot to return StreamOutbound) is a HARD error (9014), not a silent no-op.
expectFail("hot: @connect with an invalid signature is rejected", `
@stream
class Bad {
  @connect onConnect(c: StreamInbound): void {}
  @message onMessage(): void {}
}
export function probe(): i32 { return 1; }
`, "hot", "invalid signature");

// @scheduled (and @daemon) are forbidden in the hot request artifact.
expectFail("hot: @scheduled forbidden", `
class NotADaemon {
  @scheduled("30s") tick(): void {}
}
export function probe(): i32 { return 1; }
`, "hot", "is not valid in the hot request artifact");

// @stream is forbidden in the cold daemon artifact.
expectFail("cold: @stream forbidden", `
@stream
class Chat { @message onMessage(): void {} }
export function probe(): i32 { return 1; }
`, "cold", "is not valid in the cold daemon artifact");

// A unit using @stream cannot also declare @remote anywhere (project-wide).
expectFail("hot: @stream + @remote excluded", `
@stream
class Chat { @message onMessage(): void {} }
@remote
export function rpc(): i32 { return 1; }
`, "hot", "cannot declare");

// At most one @daemon class per project.
expectFail("cold: two @daemon classes", `
@daemon
class A { @scheduled("1m") a(): void {} }
@daemon
class B { @scheduled("1m") b(): void {} }
export function probe(): i32 { return 1; }
`, "cold", "Only one '@daemon' class is allowed");

// @scheduled is only valid on a method inside a @daemon class.
expectFail("cold: @scheduled outside @daemon", `
class Plain { @scheduled("1m") a(): void {} }
export function probe(): i32 { return 1; }
`, "cold", "only valid inside a '@daemon' class");

// Default request (null) mode rejects the cold-only @daemon with the generic message.
expectFail("default request: @daemon rejected", `
@daemon
class Jobs { @scheduled("30s") tick(): void {} }
export function probe(): i32 { return 1; }
`, null, "is not valid here");

if (failures) {
    console.error(`\nstreams gating: ${failures} failure(s)`);
    process.exit(1);
}
console.log("\nstreams gating: all cases passed");
