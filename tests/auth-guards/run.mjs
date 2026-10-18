// Execute the generated REST, service RPC and free RPC guards. The stub runtime
// records the returned cookies and whether an unauthorized handler was entered.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = mkdtempSync(join(tmpdir(), 'auth-guards-'));
try {
  const runtime = join(root, 'node_modules/toiljs/server');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'runtime.ts'), `
export class Request { method: i32 = 0; path: string = '/guard'; body: Uint8Array = new Uint8Array(0); }
export class Response {
  status: i32 = 200; cookies: i32 = 0;
  static text(value: string, status: i32 = 200): Response { const r = new Response(); r.status = status; return r; }
  static bytes(value: Uint8Array): Response { return new Response(); }
  static internalError(value: string): Response { return Response.text(value, 500); }
  setCookie(cookie: i32): Response { this.cookies = this.cookies * 10 + cookie; return this; }
}
export class RouteContext {}
export function matchRoute(pattern: string, req: Request): RouteContext | null { return new RouteContext(); }
export class Rest { static register(fn: (req: Request) => Response | null): void {} }
export class Rpc { static register(id: u32, fn: (body: Uint8Array) => Response): void {} }
`);
  writeFileSync(join(root, 'app.ts'), `
import { Request, Response } from 'toiljs/server/runtime';
@global namespace AuthService {
  export let valid: bool = false;
  export function hasSession(): bool { return valid; }
  export function clearSession(): i32 { return 1; }
  export function clearUserCookie(): i32 { return 2; }
}
let calls: i32 = 0;
@auth @rest('guard') class Guard {
  @get('/') run(): Response { calls++; return Response.text('ok'); }
}
@rest('method') class MethodGuard {
  @auth @get('/') run(): Response { calls++; return Response.text('ok'); }
}
@auth @service class Service {
  @remote run(): i32 { calls++; return 1; }
}
@service class MethodService {
  @auth @remote run(): i32 { calls++; return 1; }
}
@auth @remote function guardedFn(): i32 { calls++; return 1; }
function id(name: string): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = (h ^ <u32>name.charCodeAt(i)) * 0x01000193;
  return h;
}
export function probe(surface: i32, valid: bool): i32 {
  AuthService.valid = valid; calls = 0;
  let response: Response;
  if (surface == 0) response = new Guard().__tryRoute(new Request())!;
  else if (surface == 1) response = new MethodGuard().__tryRoute(new Request())!;
  else if (surface == 2) response = new Service().__rpcDispatch(id('Service.run'), new Uint8Array(0));
  else if (surface == 3) response = new MethodService().__rpcDispatch(id('MethodService.run'), new Uint8Array(0));
  else response = __toilRpcFn_guardedFn(new Uint8Array(0));
  return response.status * 1000 + response.cookies * 10 + calls;
}
`);
  const out = join(root, 'app.wasm');
  const compiled = spawnSync(process.execPath, [resolve('bin/toilscript.js'), 'app.ts', '-o', out, '--runtime', 'stub'], { cwd: root, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const { instance } = await WebAssembly.instantiate(readFileSync(out), { env: { abort() { throw new Error('Wasm abort'); } } });
  for (let surface = 0; surface < 5; surface++) {
    assert.equal(instance.exports.probe(surface, 0), 401120, `surface ${surface} rejects and clears both cookies`);
    assert.equal(instance.exports.probe(surface, 1), 200001, `surface ${surface} calls authenticated handler without clearing cookies`);
  }
  console.log('auth guard test: ALL PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
