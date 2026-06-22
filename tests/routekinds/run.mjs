// Compile a small @rest fixture and assert that explicit mutating-method
// `@query` routes emit the `toildb.route_kinds` custom section the edge uses
// as an extra runtime DB-policy clamp.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "routekinds-"));
const app = join(tmp, "app.ts");
const out = join(tmp, "app.wasm");
const runtimeDir = join(tmp, "node_modules", "toiljs", "server");
const runtime = join(runtimeDir, "runtime.ts");

function fail(msg) {
  console.error(`route-kind metadata test: ${msg}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

mkdirSync(runtimeDir, { recursive: true });
writeFileSync(
  runtime,
  `
export class Request {
  method: i32 = 0;
  path: string = "";
  body: Uint8Array = new Uint8Array(0);
}
export class Response {
  static empty(status: i32 = 204): Response { return new Response(); }
}
export class RouteContext {
  text(): string { return ""; }
}
export function matchRoute(pattern: string, req: Request): RouteContext | null {
  return new RouteContext();
}
export class Rest {
  static register(fn: (q: Request) => Response | null): void {}
}
`,
);

writeFileSync(
  app,
  `
@rest("api")
class Api {
  @query
  @post("/search")
  search(): void {}

  @post("/write")
  write(): void {}
}

export function probe(): i32 { return 1; }
`,
);

const compile = spawnSync(
  "node",
  [join(root, "bin", "toilscript.js"), app, "-o", out, "--runtime", "stub"],
  { cwd: tmp, encoding: "utf8" },
);
if (compile.status !== 0) {
  fail(
    `COMPILE FAILED\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`,
  );
}

const wasm = readFileSync(out);

function leb(buf, pos) {
  let result = 0,
    shift = 0,
    p = pos;
  for (;;) {
    if (p >= buf.length) return [0, -1];
    const b = buf[p++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) return [0, -1];
  }
  return [result >>> 0, p];
}

function findSection(buf, want) {
  let pos = 8;
  while (pos < buf.length) {
    const id = buf[pos++];
    let size;
    [size, pos] = leb(buf, pos);
    if (pos < 0) return null;
    const end = pos + size;
    if (end > buf.length || end < pos) return null;
    if (id === 0) {
      let nameLen, np;
      [nameLen, np] = leb(buf, pos);
      if (
        np >= 0 &&
        np + nameLen <= end &&
        buf.toString("latin1", np, np + nameLen) === want
      ) {
        return buf.subarray(np + nameLen, end);
      }
    }
    pos = end;
  }
  return null;
}

function decodeRouteKinds(p) {
  let pos = 0;
  const u8 = () => p[pos++];
  const u16 = () => {
    const v = p[pos] | (p[pos + 1] << 8);
    pos += 2;
    return v;
  };
  const u32 = () => {
    const v =
      (p[pos] | (p[pos + 1] << 8) | (p[pos + 2] << 16) | (p[pos + 3] << 24)) >>>
      0;
    pos += 4;
    return v;
  };
  const str = () => {
    const n = u32();
    const s = p.toString("latin1", pos, pos + n);
    pos += n;
    return s;
  };
  const version = u16();
  const count = u16();
  const routes = [];
  for (let i = 0; i < count; i++)
    routes.push({ method: u8(), kind: u8(), pattern: str() });
  if (version !== 1 || pos !== p.length) fail("toildb.route_kinds malformed");
  return routes;
}

const routeSec = findSection(wasm, "toildb.route_kinds");
if (routeSec === null) fail("toildb.route_kinds section not found");

const routes = decodeRouteKinds(routeSec);
if (routes.length !== 1)
  fail(`expected 1 query route kind, got ${routes.length}`);
if (
  routes[0].method !== 1 ||
  routes[0].kind !== 0 ||
  routes[0].pattern !== "/api/search"
) {
  fail(`wrong route kind entry: ${JSON.stringify(routes[0])}`);
}

function compileSource(source) {
  writeFileSync(app, source);
  return spawnSync(
    "node",
    [join(root, "bin", "toilscript.js"), app, "-o", out, "--runtime", "stub"],
    { cwd: tmp, encoding: "utf8" },
  );
}

function expectCompileFailure(source, expected) {
  const result = compileSource(source);
  if (result.status === 0)
    fail(`expected compile failure containing '${expected}'`);
  const text = `${result.stdout}\n${result.stderr}`;
  if (!text.includes(expected)) {
    fail(
      `expected diagnostic '${expected}'\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

expectCompileFailure(
  `
@rest("api")
class BadKind {
  @job
  @post("/job")
  run(): void {}
}
`,
  "HTTP route methods may only use @query or @action",
);

expectCompileFailure(
  `
@rest("api")
class NonAscii {
  @query
  @post("/snowman-☃")
  search(): void {}
}
`,
  "route pattern for toildb.route_kinds must be a non-empty ASCII path starting with '/'",
);

let manyRoutes = '@rest("api")\nclass TooMany {\n';
for (let i = 0; i < 2049; i++) {
  manyRoutes += `  @query\n  @post("/r${i}")\n  r${i}(): void {}\n`;
}
manyRoutes += "}\n";
expectCompileFailure(
  manyRoutes,
  "too many explicit @query HTTP routes for toildb.route_kinds",
);

rmSync(tmp, { recursive: true, force: true });
console.log("route-kind metadata test: ALL PASS");
