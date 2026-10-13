import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here,'../..');
const tmp = mkdtempSync(join(tmpdir(),'event-erasure-'));
try {
  const compile = (file,out) => spawnSync(process.execPath,[join(root,'bin/toilscript.js'),file,'-o',out,'--runtime','stub'],{encoding:'utf8'});
  const output = join(tmp,'events.wasm');
  const built = compile(join(here,'spec.ts'),output);
  assert.equal(built.status,0,built.stdout+built.stderr);
  let memory, value, result;
  let done = false;
  const bytes=(p,n)=>Buffer.from(new Uint8Array(memory.buffer,p,n));
  const {instance} = await WebAssembly.instantiate(readFileSync(output),{env:{
    abort(){throw new Error('guest abort');},
    'data.resolve_collection'(_p,_l,out){new DataView(memory.buffer).setUint32(out,7,true);return 0;},
    'data.append_once'(_h,_kp,_kl,ip,il,vp,vl){assert.equal(bytes(ip,il).toString(),'one');value=bytes(vp,vl);return 1;},
    'data.events_reference'(_h,_kp,_kl,ip,il){assert.equal(bytes(ip,il).toString(),'one');result=Buffer.alloc(16);result.writeBigUInt64LE(9n);result.writeBigUInt64LE(123n,8);return 16;},
    'data.events_redact'(_h,_kp,_kl,seq,hlc){assert.equal(seq,9n);assert.equal(hlc,123n);return done?1:0;},
    'data.events_entries'(_h,_kp,_kl,limit,after){assert.equal(limit,8);assert.equal(after,0n);result=Buffer.alloc(4+8+8+4+4+value.length+1);let p=0;p=result.writeUInt32LE(1,p);p=result.writeBigUInt64LE(9n,p);p=result.writeBigUInt64LE(123n,p);p=result.writeUInt32LE(0,p);p=result.writeUInt32LE(value.length,p);value.copy(result,p);return result.length;},
    'data.take_result'(p,n){new Uint8Array(memory.buffer,p,n).set(result);return n;},
  }});
  memory=instance.exports.memory;
  instance.exports.seed();
  assert.equal(instance.exports.page(),42);
  assert.equal(instance.exports.erase(),0);
  done=true;assert.equal(instance.exports.erase(),1);
  for (const [decorator,expression] of [['query','DB.events.redact(new Key(),new EventRef(1,1))'],['action','DB.events.entries(new Key())']]) {
    const file=join(tmp,decorator+'.ts');
    writeFileSync(file,readFileSync(join(here,'spec.ts'),'utf8')+`\n@${decorator} export function forbidden(): void { ${expression}; }\n`);
    const failed=compile(file,join(tmp,'bad.wasm'));
    assert.notEqual(failed.status,0);
    assert.match(failed.stdout+failed.stderr,/not allowed|not permitted|may not call|9017/i);
  }
  console.log('Event erasure bindings and permission gates: ALL PASS');
} finally {rmSync(tmp,{recursive:true,force:true});}
