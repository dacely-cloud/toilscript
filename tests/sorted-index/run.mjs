import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { Buffer } from 'node:buffer';
const tmp = mkdtempSync(join(tmpdir(), 'sorted-index-'));
try {
  const source = `
@data class Group { id:i32=0; constructor(id:i32=0){this.id=id;} }
@data class Item { id:u64=0; constructor(id:u64=0){this.id=id;} }
@database class App { @collection static index:SortedIndex<Group,Item>; }
@action export function seed():void {
  const ids: u64[] = [65535,258,256,2,1,0];
  for(let i=0;i<ids.length;i++) App.index.add(new Group(), SortKey.u64(ids[i]), new Item(ids[i]));
  App.index.add(new Group(1), 'b', new Item(5));
  App.index.add(new Group(1), 'a\\0', new Item(3));
  App.index.add(new Group(1), 'á', new Item(6));
  App.index.add(new Group(1), 'a', new Item(2));
  App.index.add(new Group(1), '', new Item(1));
}
@query export function walk(group:i32):i32 {
  let cursor:Uint8Array|null=null;
  let result:i32=0;
  for(let step=0;step<10;step++) {
    const page=App.index.page(new Group(group),2,cursor);
    for(let i=0;i<page.items.length;i++) result=result*10+<i32>(page.items[i].id%10);
    if(page.cursor==null)return result;
    cursor=page.cursor;
  }
  return -1;
}
@action export function remove():void {App.index.remove(new Group(),SortKey.u64(256),new Item(256));}
export function descending():bool {return SortKey.descendingU64(100)<SortKey.descendingU64(2);}
`;
  const app = join(tmp, 'app.ts'); const out = join(tmp, 'app.wasm');
  writeFileSync(app, source);
  const result = spawnSync(process.execPath, [resolve('bin/toilscript.js'), app, '-o', out, '--runtime', 'stub'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  let memory, stash;
  let unavailable = false;
  const groups = new Map();
  const mem = () => Buffer.from(memory.buffer);
  const key = (p,l) => mem().subarray(p,p+l).toString('hex');
  const u32 = n => {const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
  const { instance } = await WebAssembly.instantiate(readFileSync(out), { env: {
    abort(){throw new Error('sorted index guest aborted');},
    'data.resolve_collection'(_p,_l,out){mem().writeUInt32LE(1,out);return 0;},
    'data.membership_add'(_h,sp,sl,mp,ml){
      if(unavailable)return -1031;
      const k=key(sp,sl), row=Buffer.from(mem().subarray(mp,mp+ml));
      if(!groups.has(k))groups.set(k,new Map()); groups.get(k).set(row.toString('hex'),row);return 0;
    },
    'data.membership_remove'(_h,sp,sl,mp,ml){groups.get(key(sp,sl))?.delete(key(mp,ml));return 0;},
    'data.membership_page'(_h,sp,sl,cp,cl,limit){
      assert.equal(limit,2);
      const cursor=cl<0?null:Buffer.from(mem().subarray(cp,cp+cl));
      const rows=[...(groups.get(key(sp,sl))?.values()??[])].sort(Buffer.compare)
        .filter(row=>cursor===null||Buffer.compare(row,cursor)>0).slice(0,limit);
      const next=rows.length===limit?rows.at(-1):null;
      const parts=[u32(rows.length)]; for(const row of rows)parts.push(u32(0),u32(row.length),row);
      parts.push(Buffer.from([next===null?0:1]));if(next!==null)parts.push(u32(next.length),next);
      stash=Buffer.concat(parts);return stash.length;
    },
    'data.take_result'(p,cap){if(cap<stash.length)return -1;stash.copy(mem(),p);return stash.length;},
    'data.result_schema_version'(){return 0n;},
    'data.write_allowed'(){return 0;},
  }});
  memory=instance.exports.memory;
  instance.exports.seed();instance.exports.seed(); // Adds are idempotent.
  assert.equal(instance.exports.walk(0),12685);
  assert.equal(instance.exports.walk(1),12356); // Prefix, NUL and UTF-8 ordering.
  assert.equal(instance.exports.descending(),1);
  instance.exports.remove(); assert.equal(instance.exports.walk(0),1285);
  unavailable = true; assert.throws(() => instance.exports.seed(), /guest aborted/);
  writeFileSync(app, source+'\n@query export function invalid():void {App.index.add(new Group(),"x",new Item());}');
  const denied=spawnSync(process.execPath,[resolve('bin/toilscript.js'),app,'--noEmit'],{encoding:'utf8'});
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/may not call '.add'/);
  console.log('sorted index: ALL PASS');
} finally {rmSync(tmp,{recursive:true,force:true});}
