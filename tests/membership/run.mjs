// Exercise the typed membership cursor against a bounded ordered host ABI.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'membership-page-'));
try {
    const app = join(tmp, 'app.ts');
    const out = join(tmp, 'app.wasm');
    writeFileSync(app, `
@data class Key { id: i32 = 0; }
@data class Member { id: i32 = 0; constructor(id: i32 = 0) { this.id = id; } }
@database class App { @collection static members: Membership<Key, Member>; }
export function seed(): void { for (let i = 79; i >= 0; i--) App.members.add(new Key(), new Member(i)); }
export function walk(): i32 {
  let cursor: Uint8Array | null = null;
  let expected = 0;
  for (let step = 0; step < 100; step++) {
    const page = App.members.listPage(new Key(), 7, cursor);
    for (let i = 0; i < page.members.length; i++) {
      if (page.members[i].id != expected++) return -1;
    }
    if (page.cursor == null) return expected;
    cursor = page.cursor;
  }
  return -2;
}
`);
    const compile = spawnSync(process.execPath, [join(root, 'bin/toilscript.js'), app, '-o', out, '--runtime', 'stub'], { encoding: 'utf8' });
    if (compile.status !== 0) throw new Error(compile.stdout + compile.stderr);
    let memory;
    let stash;
    const members = new Map();
    let calls = 0;
    const frameU32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const imports = { env: {
        abort: () => { throw new Error('membership guest aborted'); },
        'data.resolve_collection': (_p, _l, out) => { new DataView(memory.buffer).setUint32(out, 1, true); return 0; },
        'data.membership_add': (_h, _sp, _sl, mp, ml) => {
            const member = Buffer.from(new Uint8Array(memory.buffer, mp, ml));
            members.set(member.toString('hex'), member);
            return 0;
        },
        'data.membership_page': (_h, _sp, _sl, cp, cl, limit) => {
            calls++;
            if (limit !== 7) throw new Error('wrong page bound');
            const cursor = cl === -1 ? null : Buffer.from(new Uint8Array(memory.buffer, cp, cl));
            const rows = [...members.values()].sort(Buffer.compare).filter(m => cursor === null || Buffer.compare(m, cursor) > 0).slice(0, limit);
            const next = rows.length === limit ? rows.at(-1) : null;
            const parts = [frameU32(rows.length)];
            for (const row of rows) parts.push(frameU32(0), frameU32(row.length), row);
            parts.push(Buffer.from([next === null ? 0 : 1]));
            if (next !== null) {
                parts.push(frameU32(next.length), next);
                members.delete(next.toString('hex')); // a deleted cursor must still resume correctly
            }
            stash = Buffer.concat(parts);
            return stash.length;
        },
        'data.take_result': (ptr, cap) => {
            if (cap < stash.length) return -1;
            new Uint8Array(memory.buffer, ptr, stash.length).set(stash);
            return stash.length;
        },
    } };
    const { instance } = await WebAssembly.instantiate(readFileSync(out), imports);
    memory = instance.exports.memory;
    instance.exports.seed();
    const count = instance.exports.walk();
    if (count !== 80 || calls !== 12) throw new Error(`paging failed: count=${count}, calls=${calls}`);
    console.log('membership: typed cursor walked all 80 members in 12 bounded pages');
} finally { rmSync(tmp, { recursive: true, force: true }); }
