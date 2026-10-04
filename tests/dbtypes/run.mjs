// Exercise the same Documents.enqueue call in stock TypeScript and ToilScript.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const spec = join(here, "spec.ts");
const tmp = mkdtempSync(join(tmpdir(), "dbtypes-"));

try {
    const typecheck = spawnSync("node", [
        join(root, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit", "--noLib", "--skipLibCheck", "--experimentalDecorators",
        "--strict", "--target", "esnext", "--module", "esnext",
        "--types", "./std/types/assembly", spec,
    ], { cwd: root, stdio: "inherit" });
    assert.equal(typecheck.status, 0, "Documents.enqueue must type-check in stock TypeScript");

    const out = join(tmp, "spec.wasm");
    const compile = spawnSync("node", [
        join(root, "bin", "toilscript.js"), spec, "-o", out, "--runtime", "stub",
    ], { cwd: root, stdio: "inherit" });
    assert.equal(compile.status, 0, "Documents.enqueue must compile in ToilScript");

    let memory;
    let status = 0;
    let calls = 0;
    const { instance } = await WebAssembly.instantiate(readFileSync(out), {
        env: {
            abort() { throw new Error("unexpected guest abort"); },
            "data.resolve_collection"(_ptr, _len, outPtr) {
                new DataView(memory.buffer).setUint32(outPtr, 1, true);
                return 0;
            },
            "data.enqueue"(handle, _keyPtr, keyLen, _valuePtr, valueLen) {
                assert.equal(handle, 1);
                assert.ok(keyLen > 0 && valueLen > 0);
                calls++;
                return status;
            },
        },
    });
    memory = instance.exports.memory;
    assert.equal(instance.exports.queue(), 1, "accepted enqueue returns true");
    for (status of [-2, -1004]) {
        assert.equal(instance.exports.queue(), 0, "absent/rejected enqueue returns false");
    }
    assert.equal(calls, 3);
    console.log("ToilDB declaration parity test suite: ALL PASS");
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
