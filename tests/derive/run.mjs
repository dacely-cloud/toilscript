// Compile @database/@derive fixtures and assert the generated hot derive runner
// and `toildb.derives` custom section stay in lockstep.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "derive-"));
const app = join(tmp, "app.ts");
const out = join(tmp, "app.wasm");
const wat = join(tmp, "app.wat");

function fail(msg) {
  console.error(`derive metadata test: ${msg}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

function compile(source, extra = []) {
  writeFileSync(app, source);
  return spawnSync(
    "node",
    [
      join(root, "bin", "toilscript.js"),
      app,
      "-o",
      out,
      "-t",
      wat,
      "--runtime",
      "stub",
      ...extra,
    ],
    { cwd: tmp, encoding: "utf8" },
  );
}

function expectCompile(source, extra = []) {
  const result = compile(source, extra);
  if (result.status !== 0) {
    fail(
      `COMPILE FAILED\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return {
    wasm: readFileSync(out),
    wat: readFileSync(wat, "utf8"),
  };
}

function expectCompileFailure(source, expected) {
  const result = compile(source);
  if (result.status === 0)
    fail(`expected compile failure containing '${expected}'`);
  const text = `${result.stdout}\n${result.stderr}`;
  if (!text.includes(expected)) {
    fail(
      `expected diagnostic '${expected}'\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

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

function decodeDerives(p) {
  let pos = 0;
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
  const derives = [];
  for (let i = 0; i < count; i++) {
    derives.push({ id: u16(), db: str(), method: str() });
  }
  if (version !== 1 || pos !== p.length) fail("toildb.derives malformed");
  return derives;
}

const fixture = `
import { Documents, View } from "toildb";

@data
class Row {
  id: string = "";
}

@database
class A {
  @collection
  rows!: Documents<string, Row>;

  @collection
  out!: View<string, Row>;

  @derive
  rebuild(): void {}

  @derive
  refresh(): void {}
}

@database
class B {
  @collection
  rows!: Documents<string, Row>;

  @collection
  out!: View<string, Row>;

  @derive
  rebuild(): void {}
}
`;

const hot = expectCompile(fixture);
const exportMatches = hot.wat.match(/\(export "derive_run"/g) ?? [];
if (exportMatches.length !== 1) {
  fail(`expected exactly one derive_run export, got ${exportMatches.length}`);
}
const section = findSection(hot.wasm, "toildb.derives");
if (section === null) fail("toildb.derives section not found");
const derives = decodeDerives(section);
const got = derives.map((d) => `${d.id}:${d.db}.${d.method}`).join(",");
const want = "0:A.rebuild,1:A.refresh,2:B.rebuild";
if (got !== want) fail(`wrong derives catalog: got '${got}', want '${want}'`);

const cold = expectCompile(fixture, ["--targetMode", "cold"]);
if (cold.wat.includes('(export "derive_run"')) {
  fail("cold artifact must not export derive_run");
}
if (findSection(cold.wasm, "toildb.derives") !== null) {
  fail("cold artifact must not emit toildb.derives");
}

expectCompileFailure(
  `
import { Documents, View } from "toildb";
@data class Row { id: string = ""; }
@database
class Bad {
  @collection rows!: Documents<string, Row>;
  @collection out!: View<string, Row>;
  @derive
  rebuild(x: i32): void {}
}
`,
  "must take no arguments and return void",
);

rmSync(tmp, { recursive: true, force: true });
