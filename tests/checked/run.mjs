import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
const tmp = mkdtempSync(join(tmpdir(), 'checked-math-'));
const types = ['i8','u8','i16','u16','i32','u32','i64','u64'];
const operations = ['add','subtract','multiply'];
try {
  let code = 'let lastOk: bool = false; export function ok(): bool {return lastOk;}\n';
  for (const type of types) for (const op of operations) {
    const param = type.endsWith('64') ? type : 'i32';
    code += `export function ${type}_${op}(a:${param},b:${param}):i64 {const r=Checked.${op}<${type}>(<${type}>a,<${type}>b);lastOk=r.ok;return <i64>r.value;}\n`;
  }
  const app = join(tmp,'app.ts'), out=join(tmp,'app.wasm'); writeFileSync(app,code);
  const result=spawnSync(process.execPath,[resolve('bin/toilscript.js'),app,'-o',out,'--runtime','stub','--noAssert'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const {instance}=await WebAssembly.instantiate(readFileSync(out),{env:{abort(){throw new Error('checked math trapped');}}});
  let state=0x514c4bn;
  const random=()=>{state=BigInt.asUintN(64,state*6364136223846793005n+1442695040888963407n);return state;};
  let count=0;
  function check(type,a,b) {
    const signed=type[0]==='i',bits=Number(type.slice(1));
    const min=signed?-(1n<<BigInt(bits-1)):0n,max=(1n<<BigInt(bits-(signed?1:0)))-1n;
    for(const op of operations) {
      const expected=op==='add'?a+b:op==='subtract'?a-b:a*b;
      const okay=expected>=min&&expected<=max;
      const params=bits===64?[a,b]:[Number(a),Number(b)];
      let value=instance.exports[`${type}_${op}`](...params);
      if(type==='u64')value=BigInt.asUintN(64,value);
      assert.equal(Boolean(instance.exports.ok()),okay,`${type} ${op} ${a},${b}`);
      assert.equal(value,okay?expected:0n,`${type} ${op} result ${a},${b}`);count++;
    }
  }
  for(const type of types) {
    const signed=type[0]==='i',bits=Number(type.slice(1));
    const min=signed?-(1n<<BigInt(bits-1)):0n,max=(1n<<BigInt(bits-(signed?1:0)))-1n;
    const values=[min,min+1n,0n,1n,2n,max-1n,max];if(signed)values.push(-1n,-2n);
    for(const a of values)for(const b of values)check(type,a,b);
    for(let i=0;i<200;i++)check(type,signed?BigInt.asIntN(bits,random()):BigInt.asUintN(bits,random()),signed?BigInt.asIntN(bits,random()):BigInt.asUintN(bits,random()));
    if(bits===8)for(let a=Number(min);a<=Number(max);a++)for(let b=Number(min);b<=Number(max);b++)check(type,BigInt(a),BigInt(b));
  }
  writeFileSync(app,'export function run():void {Checked.add<f64>(1,2);}');
  const invalid=spawnSync(process.execPath,[resolve('bin/toilscript.js'),app,'--noEmit'],{encoding:'utf8'});
  assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/requires a primitive integer type/);
  console.log(`checked math: ${count} exact BigInt comparisons PASS`);
} finally {rmSync(tmp,{recursive:true,force:true});}
