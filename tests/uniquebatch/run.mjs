import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'unique-batch-'));
try {
  const out = join(tmp, 'batch.wasm');
  const compiled = spawnSync('node', [join(root, 'bin/toilscript.js'), join(here, 'spec.ts'), '-o', out, '--runtime', 'stub'], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  let memory, key, value, result;
  let calls = 0, status = 0;
  const bytes = (p, n) => Buffer.from(new Uint8Array(memory.buffer, p, n));
  const { instance } = await WebAssembly.instantiate(readFileSync(out), {env: {
    abort() { throw new Error('guest abort'); },
    'data.resolve_collection'(p, n, dst) {
      assert.equal(bytes(p, n).toString(), 'DB/claims');
      new DataView(memory.buffer).setUint32(dst, 7, true); return 0;
    },
    'data.unique_claim'(h, kp, kl, vp, vl) {
      assert.equal(h, 7); key = bytes(kp, kl); value = bytes(vp, vl); return 0;
    },
    'data.get_many'(h, p, n) {
      calls++; assert.equal(h, 7);
      if (status < 0) return status;
      const blob = bytes(p, n); assert.equal(blob.readUInt32LE(0), 3);
      const parts = [Buffer.from([3, 0, 0, 0])]; let offset = 4;
      for (let i = 0; i < 3; i++) {
        const len = blob.readUInt32LE(offset); offset += 4;
        const present = blob.subarray(offset, offset + len).equals(key); offset += len;
        assert.equal(present, i !== 1);
        if (!present) parts.push(Buffer.from([0]));
        else {
          const header = Buffer.alloc(9); header[0] = 1; header.writeUInt32LE(value.length, 5);
          parts.push(header, value);
        }
      }
      assert.equal(offset, blob.length); result = Buffer.concat(parts); return result.length;
    },
    'data.take_result'(p, n) { assert.equal(n, result.length); new Uint8Array(memory.buffer, p, n).set(result); return n; },
  }});
  memory = instance.exports.memory;
  instance.exports.seed();
  assert.equal(instance.exports.read(), 84); assert.equal(calls, 1);
  status = -1020;
  assert.throws(() => instance.exports.read(), /unreachable|guest abort/);
  console.log('Unique batch reads: ALL PASS');
} finally { rmSync(tmp, {recursive: true, force: true}); }
