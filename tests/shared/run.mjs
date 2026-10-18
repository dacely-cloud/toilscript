import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
const root = resolve('.');
const tmp = mkdtempSync(join(tmpdir(), 'toil-shared-'));
try {
  mkdirSync(join(tmp, 'node_modules'));
  symlinkSync(root, join(tmp, 'node_modules/toilscript'));
  writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
  copyFileSync(join(root, 'tests/shared/helpers.ts'), join(tmp, 'helpers.ts'));
  const cases = ['', '0', '1', '1.1', '0.01', '0.00', '21.99', '21474836.47',
    '21474836.48', '21474837', '1.123', '1.', '.1', '-1', ' 1', '1e2', '00.25',
    '9999999999999', '2147483.6'];
  const byteCases = [0, 1, 127, 128, 255, 256, 65535, 2147483647, 2147483648, 4294967295, 0x12345678, 0xfedcba98];
  const entry = `import { readU32BE, parseCents } from './helpers';
export function cents(id:i32):i32 { return parseCents([${cases.map(x => JSON.stringify(x)).join(',')}][id]); }
export function word(n:u32, offset:i32):u32 {
  const bytes=new Uint8Array(4); bytes[0]=(n>>>24)&255; bytes[1]=(n>>>16)&255;
  bytes[2]=(n>>>8)&255; bytes[3]=n&255; return readU32BE(bytes,offset);
}`;
  writeFileSync(join(tmp, 'entry.ts'), entry);
  writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'bundler',strict:true,noEmitOnError:true,outDir:'js'},files:['helpers.ts']}));
  for (const [bin, args] of [
    ['node_modules/typescript/bin/tsc', ['-p', join(tmp,'tsconfig.json')]],
    ['bin/toilscript.js', [join(tmp,'entry.ts'),'-o',join(tmp,'entry.wasm'),'--runtime','stub']],
  ]) {
    const result=spawnSync(process.execPath,[join(root,bin),...args],{cwd:tmp,encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
  }
  const js=await import(pathToFileURL(join(tmp,'js/helpers.js')));
  const {instance}=await WebAssembly.instantiate(readFileSync(join(tmp,'entry.wasm')),{
    env:{abort:()=>{throw new Error('Wasm abort');}},
  });
  for(let i=0;i<cases.length;i++) {
    const input=cases[i];
    const valid=input.length<=13 && /^\d+(?:\.\d{1,2})?$/.test(input);
    const [whole, fraction='']=input.split('.');
    const expected=valid ? BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')) : -1n;
    const cents=expected>2147483647n ? -1 : Number(expected);
    assert.equal(js.parseCents(input),cents,input);
    assert.equal(instance.exports.cents(i),cents,input);
  }
  assert.equal(js.parseCents('21474836.47'),2147483647);
  assert.equal(js.parseCents('21474836.48'),-1);
  for(const n of byteCases) for(const offset of [-1,0,1,4,2147483647]) {
    const bytes=Uint8Array.of((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);
    assert.equal(js.readU32BE(bytes,offset),offset===0?n:0);
    assert.equal(instance.exports.word(n,offset)>>>0,js.readU32BE(bytes,offset));
  }
  console.log('shared TypeScript/ToilScript helpers: ALL PASS');
} finally { rmSync(tmp,{recursive:true,force:true}); }
