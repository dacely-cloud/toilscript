import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const tmp = mkdtempSync(join(tmpdir(), 'toil-reported-bugs-'));
function compile(name, code, extra = []) {
  const src = join(tmp, name + '.ts');
  const out = join(tmp, name + '.wasm');
  writeFileSync(src, code);
  const result = spawnSync(process.execPath, [resolve('bin/toilscript.js'), src, '-o', out, '--runtime', 'stub', ...extra], { encoding: 'utf8' });
  return { ...result, out };
}
try {
  const constructor = compile('regexp', 'export function run(): bool { return new RegExp("abc").test("abc"); }');
  assert.notEqual(constructor.status, 0);
  assert.match(constructor.stderr, /RegExp is not implemented/);
  const literal = compile('regexp-literal', 'export function run(): bool { return /abc/.test("abc"); }');
  assert.notEqual(literal.status, 0);
  const parsing = compile('parse', `
export function run(): void {
  assert(changetype<usize>(u256.tryParse('')) == 0);
  assert(changetype<usize>(u256.tryParse('12z')) == 0);
  assert(changetype<usize>(u256.tryParse('-1')) == 0);
  assert(changetype<usize>(u256.tryParse(' 1')) == 0);
  assert(changetype<usize>(u256.tryParse('0x10', 16)) == 0);
  assert(changetype<usize>(u256.tryParse('2', 2)) == 0);
  assert(u256.tryParse('0')! == u256.Zero);
  assert(u256.tryParse('00042')! == u256.fromU32(42));
  assert(u256.tryParse('fF', 16)! == u256.fromU32(255));
  assert(u256.tryParse('f'.repeat(64), 16)! == u256.Max);
  assert(changetype<usize>(u256.tryParse('1' + '0'.repeat(64), 16)) == 0);
  assert(u256.tryParse('115792089237316195423570985008687907853269984665640564039457584007913129639935')! == u256.Max);
  assert(changetype<usize>(u256.tryParse('115792089237316195423570985008687907853269984665640564039457584007913129639936')) == 0);
}
`);
  assert.equal(parsing.status, 0, parsing.stderr);
  const { instance } = await WebAssembly.instantiate(readFileSync(parsing.out), { env: { abort() { throw new Error('parse assertion failed'); } } });
  instance.exports.run();
  const overflow = compile('overflow', 'export function run(): u256 { return u256.fromString("1" + "0".repeat(64), 16); }', ['--noAssert']);
  assert.equal(overflow.status, 0, overflow.stderr);
  const trapped = await WebAssembly.instantiate(readFileSync(overflow.out), { env: { abort() { throw new Error('overflow rejected'); } } });
  assert.throws(() => trapped.instance.exports.run(), /overflow rejected/);
  console.log('reported language bugs: ALL PASS');
} finally { rmSync(tmp, { recursive: true, force: true }); }
