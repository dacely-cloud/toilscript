import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = mkdtempSync(join(tmpdir(), "toil-editor-types-"));
const write = (file, text) => writeFileSync(join(tmp, file), text);
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: "utf8" });
try {
  mkdirSync(join(tmp, "types"));
  write("Dashboard.ts", `@data
export class Dashboard { title: string = 'Home'; }
`);
  write("DashboardRecord.ts", `import { Dashboard } from './Dashboard';
@data
export class DashboardRecord {
  dashboard: Dashboard = new Dashboard();
  revision: u64 = 0;
  deleted: bool = false;
  creationDigest: string = '';
  fits(): bool { return this.encode().length <= 240 * 1024; }
}
`);
  write("global.ts", "@data\nclass GlobalRecord { value: i32 = 1; }\n");
  write("main.ts", `import { DashboardRecord } from './DashboardRecord';
export function run(): void {
  const record = new DashboardRecord();
  if (record.encode().length > 240 * 1024) return;
  const bytes: Uint8Array = record.encode();
  const restored: DashboardRecord = DashboardRecord.decode(bytes);
  assert(restored.dashboard.title == 'Home');
  assert(record.encodedSize() == bytes.length);
  assert(record.fits());
  const writer = new DataWriter();
  record.encodeInto(writer);
  const decoded: DashboardRecord = DashboardRecord.decodeFrom(new DataReader(writer.toBytes()));
  record.decodeInto(bytes);
  record.decodeIntoVersioned(bytes, 1);
  const json: JSON = decoded.toJSON();
  const fromJSON: DashboardRecord = DashboardRecord.fromJSON(json);
  const id: u32 = DashboardRecord.dataId();
  assert(fromJSON.dashboard.title == 'Home' && id != 0);
}
`);
  const types = join(tmp, "types/generated.d.ts");
  const output = join(tmp, "app.wasm");
  const compile = run(join(root, "bin/toilscript.js"), ["main.ts", "global.ts", "--outFile", output, "--editorTypes", types, "--runtime", "stub"]);
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const generated = readFileSync(types, "utf8");
  assert.match(generated, /declare module "\.\.\/DashboardRecord"/);
  assert.match(generated, /declare global/);
  assert.doesNotMatch(generated, /interface Object/);
  // Multi-tier framework builds can include the same shared model more than once.
  copyFileSync(types, join(tmp, "types/second-tier.d.ts"));
  write("global-use.ts", "const globalRecord: GlobalRecord = GlobalRecord.decode(new GlobalRecord().encode());\n");
  write("tsconfig.json", JSON.stringify({
    extends: join(root, "std/assembly.json"),
    compilerOptions: { noEmit: true, skipLibCheck: true, types: [join(root, "std/types/assembly")] },
    include: ["*.ts", "types/*.d.ts"],
  }));
  // Check the emitted declarations themselves without suppressing declaration
  // errors; the pre-existing AS standard library needs skipLibCheck in tsc.
  const config = ts.readConfigFile(join(tmp, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, tmp);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, skipLibCheck: false });
  for (const file of [types, join(tmp, "types/second-tier.d.ts")]) {
    const diagnostics = program.getSemanticDiagnostics(program.getSourceFile(file));
    assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, " ")), []);
  }
  for (const bin of [join(root, "node_modules/typescript/bin/tsc"), join(dirname(require.resolve("typescript7/package.json")), "bin/tsc")]) {
    const positive = run(bin, ["-p", "tsconfig.json"]);
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    write("negative.ts", `import { DashboardRecord } from './DashboardRecord';
const record = new DashboardRecord();
class OrdinaryRecord {}
new OrdinaryRecord().encode();
record.misspelledCodec();
record.encode('unexpected');
DashboardRecord.decode('wrong input');
const text: string = DashboardRecord.decode(new Uint8Array(0));
`);
    const negative = run(bin, ["-p", "tsconfig.json"]);
    assert.notEqual(negative.status, 0);
    for (const diagnostic of ["Property 'encode' does not exist on type 'OrdinaryRecord'", "Property 'misspelledCodec'", "Expected 0 arguments", "not assignable to parameter of type 'Uint8Array'", "not assignable to type 'string'"]) {
      assert.ok(negative.stdout.includes(diagnostic), negative.stdout + negative.stderr);
    }
    rmSync(join(tmp, "negative.ts"));
  }
  const { instance } = await WebAssembly.instantiate(readFileSync(output), {
    env: { abort() { throw new Error("codec runtime assertion failed"); } },
  });
  instance.exports.run();
  // Removing @data must also remove its declarations on the next generation.
  write("DashboardRecord.ts", "export class DashboardRecord { revision: u64 = 0; }\n");
  const regenerated = run(join(root, "bin/toilscript.js"), ["DashboardRecord.ts", "--outFile", output, "--editorTypes", types, "--runtime", "stub"]);
  assert.equal(regenerated.status, 0, regenerated.stdout + regenerated.stderr);
  assert.doesNotMatch(readFileSync(types, "utf8"), /interface DashboardRecord/);
  console.log("Editor codec types: TypeScript 6 + 7, real errors, regeneration, and Wasm parity PASS");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
