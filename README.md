<p align="center">
  <a href="https://toil.org" target="_blank" rel="noopener"><img width="256" src="media/icon.svg" alt="ToilScript logo"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/toilscript"><img src="https://img.shields.io/npm/v/toilscript.svg?color=007acc&logo=npm" alt="npm version" /></a>
  <a href="https://github.com/dacely-cloud/toilscript/releases"><img src="https://img.shields.io/github/v/release/dacely-cloud/toilscript?color=green&logo=github" alt="GitHub release" /></a>
</p>

---

## ToilScript

**ToilScript is a fork of [AssemblyScript](https://github.com/AssemblyScript/assemblyscript)** that tracks the latest upstream and adds language features not yet available in the official release.

---

## Installation

```sh
npm install toilscript
```

### Usage

This fork is a drop-in replacement for ToilScript. Simply replace your import:

```json
{
  "dependencies": {
    "toilscript": "^0.1.0"
  }
}
```

Or if migrating from official ToilScript:

```sh
npm uninstall toilscript
npm install toilscript
```

The CLI is `toilscript` (with `toilinit` to scaffold a project):

```sh
npx toilscript your-file.ts --outFile output.wasm
```

### TypeScript 7 and WebStorm

The compiler adds codec methods to `@data` and `@user` classes. TypeScript 7
cannot load the JavaScript language-service plugin that exposes these methods
to TypeScript 6 editors. Generate ordinary declarations instead:

```sh
npx toilscript server/main.ts --outFile build/server.wasm \
  --editorTypes server/toilscript.generated.d.ts
```

Or set `"editorTypes": "server/toilscript.generated.d.ts"` in the `options`
object of `toilconfig.json` so every compile refreshes it. Include the generated
file in your server's `tsconfig.json`; an existing `"include": ["./**/*.ts"]`
already includes `.d.ts` files. Use named exports for module-scoped models:

```ts
@data
export class DashboardRecord {
  revision: u64 = 0;
}

const record = new DashboardRecord();
const bytes: Uint8Array = record.encode();
const restored: DashboardRecord = DashboardRecord.decode(bytes);
```

The declarations cover `encode`, `encodeInto`, `encodedSize`, `decodeInto`,
`decodeIntoVersioned`, `toJSON`, and static `decode`, `decodeFrom`, `fromJSON`,
and `dataId`. They preserve return and argument types; ordinary classes do not
acquire these methods. They contain no executable code and do not change the
binary format. Regenerate after adding, renaming, or removing decorated classes.
Module augmentations cover top-level named exports; export module-private models
to make them augmentable. Script-global models also receive global declarations.

With toiljs 0.0.128 or later and toilscript 0.1.66 or later, `toiljs build` and
`toiljs dev` generate and refresh these files automatically next to the server
entry. Keep them included in the server TypeScript project. If WebStorm keeps
cached errors after upgrading, restart its TypeScript language service.

---

## Development instructions

A development environment can be set up by cloning the repository:

```sh
git clone https://github.com/dacely-cloud/toilscript.git
cd toilscript
npm install
npm link
```

The link step is optional and makes the development instance available globally. The full process is documented as part of the repository:

* [Compiler instructions](./src)
* [Runtime instructions](./std/assembly/rt)
* [Test instructions](./tests)
