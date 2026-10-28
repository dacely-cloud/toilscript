import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
const tmp=mkdtempSync(join(tmpdir(),'toil-unicode-'));
try {
  const out=join(tmp,'unicode.wasm');
  const result=spawnSync(process.execPath,[resolve('bin/toilscript.js'),resolve('tests/unicode/fixture.ts'),'-o',out,
    '--runtime','incremental','--exportRuntime','--memoryBase','65536'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const compositionSource=readFileSync('std/assembly/util/unicode-data.ts','utf8').match(/const COMPOSITIONS:usize=memory.data<i32>\(\[([\s\S]*?)\]\)/)[1];
  const compositionValues=compositionSource.split(',').map(x=>x.trim()).filter(Boolean).slice(0,24).map(Number);
  const signature=Buffer.alloc(compositionValues.length*4);
  compositionValues.forEach((value,i)=>signature.writeInt32LE(value,i*4));
  for(const form of ['NFC','NFD','NFKC','NFKD']) {
    const source=join(tmp,form+'.ts'), artifact=join(tmp,form+'.wasm');
    writeFileSync(source,`export function run(input:string):string { return input.normalize('${form}'); }`);
    const compiled=spawnSync(process.execPath,[resolve('bin/toilscript.js'),source,'-o',artifact,'--runtime','stub','-O3'],{encoding:'utf8'});
    assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
    assert.equal(readFileSync(artifact).includes(signature),form.endsWith('C'),`${form} composition table inclusion`);
  }
  const {instance}=await WebAssembly.instantiate(readFileSync(out),{env:{abort:()=>{throw new Error('Wasm abort');}}});
  const api=instance.exports;
  let comparisons=0;
  function normalize(input,form,literal=false) {
    const bytes=Buffer.from(input,'utf16le');
    assert(bytes.length<32768);
    new Uint8Array(api.memory.buffer).set(bytes,0);
    const length=(literal?api.normalizeLiteral:api.normalize)(0,bytes.length,form);
    assert(length>=0 && length<=32768);
    const output=Buffer.from(api.memory.buffer,32768,length).toString('utf16le');
    if(++comparisons%256===0) api.__collect();
    return output;
  }
  const decode=text=>String.fromCodePoint(...text.trim().split(' ').filter(Boolean).map(cp=>parseInt(cp,16)));
  let lineNumber=0;
  for(const line of readFileSync('tests/unicode/NormalizationTest.txt','utf8').split('\n')) {
    lineNumber++;
    const text=line.split('#')[0].trim();
    if(!text || text.startsWith('@')) continue;
    const columns=text.split(';').slice(0,5).map(decode);
    const expected=[ [1,1,1,3,3], [2,2,2,4,4], [3,3,3,3,3], [4,4,4,4,4] ];
    for(let form=0;form<4;form++) for(let col=0;col<5;col++) {
      for(const literal of [false,true]) assert.equal(normalize(columns[col],form,literal),columns[expected[form][col]],`corpus line ${lineNumber}, form ${form}, column ${col}, literal ${literal}`);
    }
  }
  // Unpaired UTF-16 units are preserved. Long reverse-class runs exercise merge sorting.
  const special=['','plain ASCII','A\ud800\u0301\udc00','\udbff\udfff','a'+('\u0315\u0300'.repeat(3000)),
    '\u0315\u0300A','\u1100\u1161\u11a8','\uffa1\uffc2','\u212a\ufb03\u00a0'];
  for(const input of special) for(const [form,id] of ['NFC','NFD','NFKC','NFKD'].map((x,i)=>[x,i])) {
    assert.equal(normalize(input,id),input.normalize(form),`special ${form}`);
  }
  assert.throws(()=>api.invalidForm(),/abort/);
  const names=['Cn','Lu','Ll','Lt','Lm','Lo','Mn','Mc','Me','Nd','Nl','No','Pc','Pd','Ps','Pe','Pi','Pf','Po','Sm','Sc','Sk','So','Zs','Zl','Zp','Cc','Cf','Cs','Co'];
  const categories=names.map(name=>new RegExp(`^\\p{${name}}$`,'u'));
  const properties=[/^\p{L}$/u,/^\p{M}$/u,/^\p{N}$/u,/^\p{White_Space}$/u];
  const points=[-1,0x110000,0,9,32,65,97,0x1c5,0x300,0x903,0x20dd,0x2160,0xbc,0x4e00,0x1f600,0xd800,0xe000,0x378,0x10ffff];
  if(process.versions.unicode==='17.0') for(let i=0;i<20000;i++) points.push((Math.imul(i,104729)>>>0)%0x110000);
  for(const cp of points) {
    const value=cp<0||cp>0x10ffff ? '' : String.fromCodePoint(cp);
    const category=value ? names[categories.findIndex(re=>re.test(value))] : 'Cn';
    assert.equal(api.category(cp),(category.charCodeAt(0)<<8)|category.charCodeAt(1),`category U+${cp.toString(16)}`);
    const flags=properties.reduce((bits,re,i)=>bits|(Number(re.test(value))<<i),0);
    assert.equal(api.properties(cp),flags,`properties U+${cp.toString(16)}`);
  }
  // Every Unicode 17 simple mapping, independent of the host Node Unicode version.
  let lowerChecks=0;
  for(const [cp,lower] of JSON.parse(readFileSync('tests/unicode/lowercase.json','utf8'))) {
    const bytes=Buffer.from(String.fromCodePoint(cp),'utf16le');
    new Uint8Array(api.memory.buffer).set(bytes,0);
    const length=api.lowercase(0,bytes.length);
    const expected=cp===0x130 ? 'i\u0307' : String.fromCodePoint(lower);
    assert.equal(Buffer.from(api.memory.buffer,32768,length).toString('utf16le'),expected,`lowercase U+${cp.toString(16)}`);
    if(++lowerChecks%256===0) api.__collect();
  }
  for(const [input,expected] of [
    [' AΣ',' aς'], ['\u1c89Σ','\u1c8aς'], ['AΣ\u1c89','aσ\u1c8a'],
    ['A'+'\u0301'.repeat(64)+'Σ','a'+'\u0301'.repeat(64)+'ς'],
    ['AΣ'+'\u0301'.repeat(64)+'B','aσ'+'\u0301'.repeat(64)+'b'],
    ['\u0345Σ','\u0345σ'], ['A\u0345Σ','a\u0345ς'],
  ]) {
    const bytes=Buffer.from(input,'utf16le');
    new Uint8Array(api.memory.buffer).set(bytes,0);
    const length=api.lowercase(0,bytes.length);
    assert.equal(Buffer.from(api.memory.buffer,32768,length).toString('utf16le'),expected,`contextual lowercase ${JSON.stringify(input)}`);
  }
  const mask=(1n<<64n)-1n;
  let seed=0x123456789abcdefn;
  const values=[0n,1n,mask,mask+1n,(1n<<128n)-1n,(1n<<256n)-1n];
  for(let power=1n;power<(1n<<256n);power*=10n) values.push(power-1n,power,power+1n);
  for(let i=0;i<4000;i++) {
    seed=BigInt.asUintN(256,seed*0x2360ed051fc65da44385df649fccf645n+0x123456789n);
    values.push(seed);
  }
  for(const value of values) for(const wide of [0,1]) {
    const n=BigInt.asUintN(wide?256:128,value);
    const length=api.decimal(n&mask,(n>>64n)&mask,(n>>128n)&mask,(n>>192n)&mask,wide);
    assert.equal(Buffer.from(api.memory.buffer,32768,length).toString('utf16le'),n.toString(),`decimal ${n}`);
    api.__collect();
  }
  console.log(`${lowerChecks} Unicode 17 lowercase mappings and ${values.length*2} decimal conversions passed`);
  console.log(`Unicode 17: ${comparisons} normalization conformance checks and ${points.length} category/property checks passed`);
} finally {rmSync(tmp,{recursive:true,force:true});}
