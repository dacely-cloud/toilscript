import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import binaryen from "binaryen";
import * as glue from "../../src/glue/binaryen.js";
import { AtomicRMWOp, Module, TypeRef } from "../../dist/toilscript.js";

// These constants are inlined into the compiler. A changed C API value can
// silently weaken atomic operations even when generated Wasm still validates.
const source = readFileSync(new URL("../../src/module.ts", import.meta.url), "utf8");
let checked = 0;
for (const match of source.matchAll(/\b\w+\s*(?::\s*\w+)?\s*=\s*(\d+)\s*\/\*\s*(_\w+)\s*\*\//g)) {
  const [, value, name] = match;
  assert.equal(typeof binaryen[name], "function", `${name} is missing from Binaryen`);
  assert.equal(Number(value), binaryen[name](), `${name} changed in Binaryen`);
  ++checked;
}
assert.ok(checked > 600, "all C API constants must be checked");
for (const [name, value] of Object.entries(glue)) {
  assert.notEqual(value, undefined, `${name} is missing from the glue`);
}

const module = Module.create(false, TypeRef.I32);
try {
  const ptr = module.i32(0);
  const value = module.i32(42);
  const seqCst = binaryen._BinaryenMemoryOrderSeqCst();
  const operations = [
    [module.atomic_load(4, ptr, TypeRef.I32), "memoryOrder"],
    [module.atomic_store(4, ptr, value, TypeRef.I32), "memoryOrder"],
    [module.atomic_rmw(AtomicRMWOp.Add, 4, 0, ptr, value, TypeRef.I32), "memoryOrder"],
    [module.atomic_cmpxchg(4, 0, ptr, value, value, TypeRef.I32), "memoryOrder"],
    [module.atomic_fence(), "order"],
    [module.atomic_fence("custom-memory"), "order"],
  ];
  for (const [expr, property] of operations) {
    assert.equal(binaryen.getExpressionInfo(expr)[property], seqCst,
      "default atomic operations must remain sequentially consistent");
  }
} finally {
  module.dispose();
}
console.log(`Binaryen ABI: ${checked} constants, all glue exports, sequentially consistent atomics PASS`);
