// Exercise compiled guest bindings: bounded reads in @query, wire arguments,
// value decoding, absent results, and typed errors distinguishable from absence.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const tmp = mkdtempSync(join(tmpdir(), "events-read-"));
try {
  const out = join(tmp, "events.wasm");
  const compiled = spawnSync("node", [join(root, "bin/toilscript.js"), join(here, "spec.ts"), "-o", out, "--runtime", "stub"], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  let memory;
  let value;
  let key;
  let status = -2;
  let takeCalls = 0;
  const bytes = (ptr, len) => Buffer.from(new Uint8Array(memory.buffer, ptr, len));
  const checkKey = (h, kp, kl) => {
    assert.equal(h, 7);
    assert.deepEqual(bytes(kp, kl), key);
  };
  const { instance } = await WebAssembly.instantiate(readFileSync(out), { env: {
    abort() { throw new Error("guest abort"); },
    "data.resolve_collection"(p, l, outPtr) {
      assert.equal(bytes(p, l).toString(), "DB/events");
      new DataView(memory.buffer).setUint32(outPtr, 7, true);
      return 0;
    },
    "data.append_once"(h, kp, kl, ip, il, vp, vl) {
      assert.equal(h, 7);
      assert.equal(bytes(ip, il).toString(), "revision:6");
      key = bytes(kp, kl);
      value = bytes(vp, vl);
      return 1;
    },
    "data.events_get"(h, kp, kl, ip, il) {
      checkKey(h, kp, kl);
      assert.equal(bytes(ip, il).toString(), "revision:6");
      return status;
    },
    "data.events_last"(h, kp, kl) {
      checkKey(h, kp, kl);
      return status;
    },
    "data.take_result"(p, len) {
      takeCalls++;
      assert.equal(len, value.length);
      new Uint8Array(memory.buffer, p, len).set(value);
      return len;
    },
  }});
  memory = instance.exports.memory;
  instance.exports.seed();
  for (const read of [instance.exports.get, instance.exports.last]) {
    status = -2;
    const before = takeCalls;
    assert.equal(read(), -1);
    assert.equal(instance.exports.error(), 0);
    assert.equal(takeCalls, before);
    status = value.length;
    assert.equal(read(), 42);
    assert.equal(takeCalls, before + 1);
    status = -1031; // retryable storage failure must be distinguishable from absence
    assert.equal(read(), -1);
    assert.equal(instance.exports.error(), 31);
    assert.equal(takeCalls, before + 1);
  }
  console.log("Events point reads: ALL PASS");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
