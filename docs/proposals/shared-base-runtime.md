# Proposal: Shared Base Runtime for Apps (Deno + Node)

## Status

Draft

## Problem

The apps subprocess runtime exists today in two near-duplicate copies:

- `packages/apps/deno-runtime/` — the Deno implementation (files at root)
- `packages/apps/node-runtime/` — the Node implementation (files under `src/`)

A normalized diff of all 70 non-test source files (stripping import-path extensions,
`import type` vs `import`, and prettier/tabs-vs-spaces formatting) shows the two trees
are **~90% byte-identical logic**. The four largest apparent diffs (`BlockBuilder.ts`,
`lib/accessors/mod.ts`, `lib/ast/operations.ts`, `handlers/uikit/handler.ts`) each reduce
to **exactly 2 differing tokens** once sorted and whitespace-stripped — those tokens being
the relocated `require(...)` calls.

Maintaining two copies means every bug fix, accessor change, or handler addition must be
applied twice and kept in sync by hand. The goal is a single **base runtime** that owns all
shared logic, with each platform supplying a thin adapter for the genuinely
platform-specific surface.

## The Platform Boundary

Every genuine divergence between the two runtimes reduces to **one of 11 capabilities**.
The base runtime depends only on a `RuntimePlatform` interface; each runtime supplies a
concrete adapter.

```ts
interface RuntimePlatform {
  // ── module resolution (the largest coupling: 19 files) ──
  require(specifier: string): unknown;          // apps-engine runtime classes + sandboxed app require
  prepareEnvironment(): void;                    // deno: patch Socket.prototype._final; node: no-op

  // ── transport ──
  readStdin(): AsyncIterable<Uint8Array>;        // deno: Deno.stdin.readable    | node: process.stdin
  writeStdout(bytes: Uint8Array): Promise<void>; // deno: writeAll(Deno.stdout)  | node: process.stdout.write
  writeStderr(bytes: Uint8Array): Promise<void>; // deno: writeAll(Deno.stderr)  | node: process.stderr.write

  // ── process lifecycle ──
  pid: number;                                   // Deno.pid    | process.pid
  argv: string[];                                // Deno.args   | process.argv
  parseArgs(argv: string[]): ParsedArgs;         // @std/cli    | node:util
  exit(code: number): never;                     // Deno.exit   | process.exit
  registerErrorHandlers(report): void;           // addEventListener | process.on('uncaughtException')

  // ── rpc response correlation ──
  createResponseObserver(): ResponseObserver;    // EventTarget(+ErrorEvent/CustomEvent) | EventEmitter

  // ── file io ──
  readFile(path: string): Promise<Uint8Array>;   // Deno.open+toArrayBuffer | node:fs/promises readFile
}
```

Everything else — the handler layer, accessor layer, builders, extenders, modify/, AST,
room logic, codec, secureFields, logger — is logically identical and moves to the base
unchanged (modulo import-path/idiom normalization that converges automatically under one
toolchain).

## Decisions Taken

### `require` injection: init-time singleton (Option A)

The 19 `require`-coupled files are constructed deep in the tree (builders instantiated by
`ModifyCreator`, etc.), so threading `platform` through every constructor would be
invasive. Instead:

- The base exposes `setPlatform(platform)`, called **once** in `main()` before any handler
  runs.
- `require`-coupled files read `platform.require` from a base-internal singleton.

This matches today's module-level `require` usage (Deno imports a shim; Node uses the global
CJS `require`) and keeps churn to the shared files near zero. The alternative — constructor
threading (pure DI) — was rejected because it touches every builder/extender/modify
signature for no functional gain.

### `construct.ts buildRequire`

The allow-lists (`ALLOWED_NATIVE_MODULES` / `ALLOWED_EXTERNAL_MODULES`) and the eval shell
are base. Only the specifier-prefix policy (`npm:` / `node:` handling, Buffer injection) and
`prepareEnvironment` differ → both fold into `platform`.

## Suggested Package Shape

```
packages/apps/
  base-runtime/        # the ~58 single-source files + RuntimePlatform interface + setPlatform()
  deno-runtime/        # adapter: require.ts, parseArgs, EventTarget observer, Deno io + bootstrap
  node-runtime/        # adapter: loader-hook, parseArgs, EventEmitter observer, node io + bootstrap
```

## Disposition Legend

- **BASE** — moves to base unchanged (only import-path/idiom normalization).
- **BASE+require** — moves to base; the only coupling is `require()` → reads injected `platform.require`.
- **BASE+platform** — moves to base; needs a non-require capability injected.
- **SPLIT** — logic core moves to base; a thin slice stays in the adapter.
- **ADAPTER** — platform-specific implementation, one copy per runtime.

## Full Inventory

### `lib/` core

| File | Disposition | Injected capability / notes |
|---|---|---|
| `lib/codec.ts` | BASE+require | `require('.../App.js')` to load `App` class |
| `lib/secureFields.ts` | BASE | identical |
| `lib/sanitizeDeprecatedUsage.ts` | BASE | — |
| `lib/requestContext.ts` | BASE | — |
| `lib/room.ts` | BASE | only `??` / strictness idiom |
| `lib/roomFactory.ts` | BASE | — |
| `lib/wrapAppForRequest.ts` | BASE | — |
| `lib/logger.ts` | BASE | use Node's `implements ILogger` superset as canonical |
| `lib/messenger.ts` | SPLIT | `writeStdout` + `createResponseObserver` injected; Queue/encode logic is base |
| `lib/metricsCollector.ts` | BASE+platform | `writeStderr`, `pid` |
| `lib/parseArgs.ts` | ADAPTER | shape differs (`@std/cli` vs `node:util`); exposed via `platform.parseArgs` |
| `lib/require.ts` | ADAPTER (deno) | becomes the Deno `require` impl |
| `lib/loader-hook.ts` | ADAPTER (node) | Node `registerHooks` resolver |

### `lib/ast/`

| File | Disposition | Notes |
|---|---|---|
| `lib/ast/mod.ts` | BASE | drop `@deno-types` comments; use real acorn imports |
| `lib/ast/operations.ts` | BASE | type-assertion idiom only |
| `acorn.d.ts`, `acorn-walk.d.ts` | BASE | dedupe the two copies (deno root vs node `lib/ast/`) into one |

### `lib/accessors/`

| File | Disposition | Notes |
|---|---|---|
| `accessors/mod.ts` | BASE | 48-line "diff" was whitespace + `WithProxy` typing |
| `accessors/http.ts` | BASE | identical after norm |
| `accessors/formatResponseErrorHandler.ts` | BASE | byte-identical today |
| `accessors/notifier.ts` | BASE+require | — |
| `accessors/builders/BlockBuilder.ts` | BASE+require | loads BlockType/ElementType/TextObjectType |
| `accessors/builders/DiscussionBuilder.ts` | BASE+require | — |
| `accessors/builders/LivechatMessageBuilder.ts` | BASE+require | — |
| `accessors/builders/MessageBuilder.ts` | BASE+require | — |
| `accessors/builders/RoomBuilder.ts` | BASE+require | — |
| `accessors/builders/UserBuilder.ts` | BASE+require | — |
| `accessors/builders/VideoConferenceBuilder.ts` | BASE+require | — |
| `accessors/extenders/HttpExtender.ts` | BASE | byte-identical today |
| `accessors/extenders/MessageExtender.ts` | BASE+require | — |
| `accessors/extenders/RoomExtender.ts` | BASE+require | — |
| `accessors/extenders/VideoConferenceExtend.ts` | BASE+require | — |
| `accessors/modify/ModifyCreator.ts` | BASE+require | — |
| `accessors/modify/ModifyExtender.ts` | BASE+require | — |
| `accessors/modify/ModifyUpdater.ts` | BASE+require | — |

### `handlers/`

| File | Disposition | Notes |
|---|---|---|
| `handlers/api-handler.ts` | BASE | lint-directive idiom only |
| `handlers/outboundcomms-handler.ts` | BASE | — |
| `handlers/scheduler-handler.ts` | BASE | — |
| `handlers/slashcommand-handler.ts` | BASE | type-assertion idiom only |
| `handlers/videoconference-handler.ts` | BASE | — |
| `handlers/uikit/handler.ts` | BASE+require | — |
| `handlers/listener/handler.ts` | BASE+require | — |
| `handlers/lib/assertions.ts` | BASE | — |
| `handlers/app/handler.ts` | BASE | dispatch table |
| `handlers/app/handleInitialize.ts` | BASE | — |
| `handlers/app/handleGetStatus.ts` | BASE | — |
| `handlers/app/handleSetStatus.ts` | BASE+require | — |
| `handlers/app/handleOnEnable.ts` | BASE | — |
| `handlers/app/handleOnDisable.ts` | BASE | — |
| `handlers/app/handleOnInstall.ts` | BASE | — |
| `handlers/app/handleOnUninstall.ts` | BASE | — |
| `handlers/app/handleOnUpdate.ts` | BASE | — |
| `handlers/app/handleOnPreSettingUpdate.ts` | BASE | — |
| `handlers/app/handleOnSettingUpdated.ts` | BASE | — |
| `handlers/app/handleUploadEvents.ts` | BASE+platform | `readFile(path)` |
| `handlers/app/construct.ts` | SPLIT | `require`, `prepareEnvironment`, `buildRequire` specifier policy injected; sandbox-eval logic is base |

### Top-level / entry / config

| File | Disposition | Notes |
|---|---|---|
| `AppObjectRegistry.ts` | BASE | IIFE-paren idiom only |
| `error-handlers.ts` | SPLIT | notification-shape builder is base; `registerErrorHandlers` hook is adapter |
| `main.ts` | SPLIT | message loop is base; `readStdin` / `argv` / `exit` / observer-dispatch injected |
| `globals.d.ts` (node) | ADAPTER (node) | ambient types |
| `deno.jsonc`, `deno.runtime.jsonc`, `deno.lock`, `.gitignore` | ADAPTER (deno) | + import map for adapter wiring |
| `tsconfig.json` (node) | ADAPTER (node) | — |

## Tally

- **BASE (pure)**: 33 files
- **BASE+require**: 19 files
- **BASE+platform**: 2 files (`metricsCollector`, `handleUploadEvents`)
- **SPLIT**: 4 files (`main`, `messenger`, `construct`, `error-handlers`)
- **ADAPTER**: `require.ts` / `loader-hook.ts`, `parseArgs.ts`, `globals.d.ts`, config

→ **~58 of 62 logic files become single-source.** Only 4 files split, and the per-runtime
adapter is roughly ~250 lines total.

## Out of Scope (this proposal)

- Step-by-step migration ordering and the strategy for keeping both runtimes green during
  the move (to be covered in a follow-up implementation plan).
- Test consolidation: both trees carry parallel `tests/` suites that would also collapse to
  a single base suite running against each adapter.
