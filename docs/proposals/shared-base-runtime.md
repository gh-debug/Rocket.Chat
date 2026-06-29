# Proposal: Shared Base Runtime for Apps (Deno + Node)

## Status

Draft. This rewrite **supersedes** the original version (added in `981f479c40`); its
premises no longer hold (see [What changed](#what-changed-since-the-original-proposal)).
All numerics below were re-derived from the current tree.

## Problem

The apps subprocess runtime exists today as two near-duplicate trees:

- `packages/apps/deno-runtime/` — the Deno implementation (files at root)
- `packages/apps/node-runtime/src/` — the Node implementation

Node is the **canonical** runtime and will replace Deno at a future major release. Until
then both must ship and stay in lockstep, so every accessor change, handler addition, or bug
fix has to be applied twice by hand.

After Deno's move to `node:*` compatibility and this branch's convergence work, the two trees
now hold **57 non-test source files each, over an identical path set**, and differ in only
**5 files**. The remaining per-file diffs are overwhelmingly toolchain idiom (import order,
`import type` splitting, `?.`, line wrapping) that collapses automatically under a single
lint/format/tsconfig.

So the thesis of the original proposal **flips**: the shared base is not a 90%-identical
core to be carved out of a thicket of couplings — it is **almost the entire tree**, and the
per-runtime adapter is **tiny (5 files + config)**. The base is essentially today's
`node-runtime/src` minus those 5 adapter files.

## What changed since the original proposal

The original doc modeled the boundary as an **11-capability `RuntimePlatform` interface** with
a `setPlatform()` singleton injecting `require`/transport/`pid`/`argv`/`exit`/observer/
`readFile`/`readStdin`/etc., and claimed **19 `require`-coupled files**. That model is obsolete:

- **Deno dropped its native APIs** (`Deno.*`, `@std/cli`) and runs on `node:*` compat
  (`node:process`, `node:net`, `node:module`, `node:fs/promises`, `node:events`, `node:util`,
  `node:buffer`). Most of the 11 capabilities collapsed because both runtimes now call the
  same `node:` APIs. Concretely, the message loop reads stdin **identically** in both
  (`for await (const message of decoder.decodeStream(process.stdin))` —
  `deno-runtime/main.ts:101`, `node-runtime/src/main.ts:102`), so `readStdin`/`writeStderr`/
  `pid`/`argv`/`exit` are no longer seams at all.
- **The `require` coupling collapsed to one file.** Every explicit `require(...)` call now
  lives only in `handlers/app/construct.ts` (Deno also imports the `lib/require.ts` shim it
  feeds). Builders, extenders, modify/, handlers and accessors use plain static imports
  resolved by the platform's module-resolution mechanism — which is why they are byte-identical
  after idiom normalization.

## The genuine seam: 5 files

These are the only files with irreducible per-runtime differences. Everything else is base.

### 1. Module resolution — `lib/require.ts` (Deno) ↔ `lib/loader-hook.ts` (Node)

The mechanism that makes bare `@rocket.chat/apps[-engine]` specifiers resolve to compiled
output.

- **Deno** (`lib/require.ts`): `createRequire(import.meta.url)` plus `import.meta.resolve`,
  stripping `apps-engine/src/` → `apps-engine/`. Paired with the `deno.jsonc` import map
  (config, not code).
- **Node** (`lib/loader-hook.ts`): `registerHooks({ resolve })` redirecting the
  `@rocket.chat/apps` prefix to the package root. Imported for side effect at the top of
  `main.ts`; nothing calls it.

This capability **resists** the injection model and is *not* a runtime-injected function — see
[Module resolution is not an injectable capability](#module-resolution-is-not-an-injectable-capability).

### 2. stdout transport — `lib/transports/stdoutTransport.ts`

- **Deno**: `writeAll(Deno.stdout, message)` via `@std/io`.
- **Node**: `process.stdout.write(message, cb)` wrapped in a Promise.

This **must stay Deno-specific**: `process.stdout.write` is broken under Deno's node-compat
stream handling (**denoland/deno#22871**, filed by Douglas). Do not converge it.

This seam is already cleanly abstracted: `lib/messenger.ts` defines a `Transport` interface,
a `setTransport()` injector, and a `noopTransport` default. **That is the template the whole
design generalizes** (see [Injection model](#injection-model)).

### 3. `handlers/app/construct.ts`

Builds the sandboxed `require` and `eval`s the app. Shared: the allow-lists
(`ALLOWED_NATIVE_MODULES`/`ALLOWED_EXTERNAL_MODULES`), the `buildRequire` dispatch, and the
eval-shell skeleton. Per-runtime:

- **Deno**: imports `require` from `lib/require`; patches `Socket.prototype._final`
  (`prepareEnvironment()`); injects `Buffer` (from `require('buffer')`) and shadows `Deno`
  (→ `undefined`) into the eval shell —
  `(async (exports,module,require,Buffer,console,globalThis,Deno) => …)`.
- **Node**: uses global `require`; imports `App` directly and uses a `_ConstructedApp`
  class trick for typing; eval shell is
  `(async (exports,module,require,console,globalThis) => …)` (no `Buffer`/`Deno`).

> An apps subprocess constructs **exactly one app**, so `construct.ts` runs **once per
> process**. Placement of process-global side effects (e.g. the `Socket` patch) is a
> readability choice, never an idempotency concern.

### 4. `error-handlers.ts`

- **Deno**: `addEventListener('unhandledrejection' | 'error', …)`.
- **Node**: `process.on('uncaughtException', …)`.

The **notification shape is identical** (converged on this branch). Only the registration
mechanism differs. This file is adapter code that *calls* base `Messenger.sendNotification`;
it is not injected into the base.

### 5. `main.ts`

- **Deno**: `import process from 'node:process'`; the `--subprocess` guard writes a plain string.
- **Node**: `import './lib/loader-hook'` first; the guard wraps the message in `TextEncoder`;
  `void main()`.

The message loop and observer dispatch (both now `emit` via the `EventEmitter` observer) are
**base**. Each adapter's `main.ts` is reduced to a thin bootstrap (see below).

## File inventory

- **57** non-test `.ts` files per runtime, identical path set.
- **52** of them are **base** (move to `base-runtime/` unchanged modulo idiom normalization).
- **5** are the seam files above; each runtime keeps its own variant.
- ~30 of the 52 currently show a diff that is **pure toolchain idiom** (import order,
  `import type`, `?.`, `as unknown as`, `@ts-expect-error` removal, line wrapping). These
  **auto-converge** under one shared eslint/prettier/tsconfig at extraction — they are **not
  work** and must not be hand-converged.

## Design

### Injection model

Generalize the existing `Transport` / `setTransport()` / `noopTransport` pattern from
`messenger.ts`. Use **independent module-level injectors**, each with a sane no-op default —
**not** a single `setPlatform(platform)` god-object (that is the obsolete 11-capability shape
in miniature, forcing unrelated capabilities into one type and one injection point).

The surface divides cleanly in two:

**(a) Injected into the base** — values the base *reads* at runtime, each with a setter:

| Injector | Read by | Deno | Node |
|---|---|---|---|
| `setTransport(transport)` *(exists)* | `messenger.ts` | `stdoutTransport` (`@std/io`) | `stdoutTransport` (`process.stdout`) |
| `setSandboxRequire(require)` | `construct.ts` | `lib/require` shim | global `require` |
| `setSandboxGlobals(globals)` | `construct.ts` | `{ Buffer, Deno: undefined }` | `{}` |

`setSandboxGlobals` folds construct's eval-shell argument difference into **data**: the base
eval shell binds the common names (`exports, module, require, console, globalThis`) and spreads
the injected extras, so the shell skeleton becomes single-source.

**(b) Adapter bootstrap responsibilities** — steps the adapter's thin `main.ts` performs
*before* invoking the base message loop (adapter → base direction; no injection needed):

1. Ensure host module resolution (Node: `import './lib/loader-hook'`; Deno: import-map config —
   nothing to import).
2. The `--subprocess` guard.
3. Wire the injectors from (a).
4. `prepareEnvironment()` — Deno patches `Socket.prototype._final`; Node no-op. **Hoisted to
   bootstrap** (it is a process-global side effect; doing it once at startup is cleaner than
   inside `construct`).
5. `registerErrorListeners()`.
6. Invoke the base message loop.

This keeps each adapter's `main.ts` to a short, legible bootstrap and matches what the code
already does today (`node-runtime/src/main.ts:132-134` already calls
`Messenger.setTransport(stdoutTransport)` then `registerErrorListeners()`).

### Module resolution is not an injectable capability

Resolution does not fit the `setX()` model and the proposal does not pretend it does. It is
**two distinct concerns**:

1. **Host-resolution bootstrap** (adapter responsibility, not a base function with a signature):
   each adapter guarantees that bare `@rocket.chat/apps[-engine]` specifiers resolve to compiled
   output, by whatever mechanism its platform provides — Node's side-effecting `loader-hook`
   import, Deno's import map. This is partly code (Node) and partly config (Deno).
2. **Sandbox `require`** (a genuine injected capability — `setSandboxRequire` above): the
   construct-time `require` handed to the app for its `node:`/`npm:`/`apps-engine` specifiers.

### Package shape

```
packages/apps/
  base-runtime/        # 52 shared files + the injector definitions; own runtime tsconfig
  deno-runtime/        # adapter: require.ts, stdoutTransport, construct, error-handlers, main + deno config
  node-runtime/        # adapter: loader-hook, stdoutTransport, construct, error-handlers, main + node config
```

These are **directories under the single `@rocket.chat/apps` package**, not separate npm
packages.

**Build & consumption (decision P1):**

- `base-runtime/` has its **own runtime-flavored tsconfig** — `module: nodenext`,
  `moduleResolution: nodenext`, `target: es2023`, `types: ["node"]` — i.e. the settings
  `node-runtime/tsconfig.json` uses today, because the base *is* that code. It compiles to
  `base-runtime/dist`.
- Both runtimes consume it as **compiled output** via the specifier
  `@rocket.chat/apps/base-runtime/dist/...`:
  - **Node**: resolved by the **existing** `loader-hook` branch (`@rocket.chat/apps/X` →
    `path.join(appsPackageDir, X)`).
  - **Deno**: resolved by the **existing** import-map entry `@rocket.chat/apps/` → `../`
    plus `sloppy-imports` (the same way it already consumes `@rocket.chat/apps/dist/...` and
    `apps-engine` — Deno reads compiled output, not TS source).
  - **No new resolver branch and no new import-map entry** — the base rides the mechanism
    seam-file #1 already provides. Because the specifier string is identical in both adapters
    (cf. the existing shared `@rocket.chat/apps/dist/server/misc/UIHelper` import), there is no
    idiom re-divergence.
- Each runtime's `build`/`typecheck` pipeline gains one `tsc -p base-runtime/tsconfig.json`
  step.

**Why a separate dir and not fold base into the main package `src/` (P2)?** Folding the base
into `src/` (compiled by the package's main build) would force it under the **server** tsconfig,
which is CommonJS / classic-node resolution — divergent from the runtime's `nodenext`/`es2023`.
A background investigation of switching the main package to `nodenext` found it **moderate-to-high
risk**: `@rocket.chat/tsconfig/server.json` sets `module: commonjs` / `moduleResolution: node`
and **all 36 server-tier packages are uniformly CJS** (no nodenext precedent); `@rocket.chat/apps`
ships CJS with **no `exports` map**, and consumers (`apps/meteor`, `"type": "commonjs"`) import
~50+ **extensionless** deep `dist/...` paths relying on classic resolution; flipping to nodenext
would require adding `.js` extensions to **~590 relative imports across 219 files** and risk
type-resolution breakage in every deep-path consumer. P2 is therefore recorded as a **possible
future consolidation, gated on a deliberate, coordinated nodenext migration** — not part of this
proposal.

### Test strategy (decision K)

Tests are per-runtime today, on different harnesses: Node uses `node:test`; Deno uses
`deno.land/std@0.203.0` + `deno test --no-check` (21 suites / 163 steps). They are not shared.

- **Base-logic suites live in `base-runtime/` and run under `node:test`.** Node is canonical,
  `node:test` typechecks cleanly, and post-extraction this logic is single-source and
  platform-agnostic — so it is validated once, with types. This is the bulk of the suites.
- **Each adapter keeps a thin platform suite** under its native harness: Deno's `deno test`
  over the Deno seam (transport via `@std/io`, the `Socket._final` patch, error-handler
  registration), Node's `node:test` over the Node seam.
- **Do not** re-run the base suite under `deno test`: it would add a `--no-check` execution
  path with no type safety, duplicating coverage the canonical Node run already provides.

This is *not* unification — unifying is blocked by the harness asymmetry and by `deno check`
being broken (below), and there is little value in a cross-runtime test abstraction for logic
that is now single-source.

**Known coverage boundary:** the Deno *base* is exercised only transitively (the base is
identical bytes for both); only the Deno *seam* is covered by `deno test`. State this
explicitly. Fixing `deno check`'s apps-engine resolution would let a Deno seam suite typecheck
too.

## Environment facts the design accounts for

- **`deno check` is globally broken for deno-runtime**: any file importing
  `@rocket.chat/apps-engine` fails on the built `.d.ts` (`Failed resolving types. Relative
  import path "." not prefixed…`). Deno is gated **only** by `deno task test` (`--no-check`).
  Typecheck parity is unenforceable on the Deno side until apps-engine type resolution is fixed.
- **Node typecheck**: from `packages/apps/`, `yarn run typecheck:node-runtime` =
  `tsc -p node-runtime/tsconfig.json --noEmit`. `node-runtime` has no `package.json`; it builds
  as part of `@rocket.chat/apps` (`build:node-runtime` → `node-runtime/dist`).
- **Config**: `deno.runtime.jsonc` is **gitignored** (generated, absolute paths); the tracked
  config is `deno.jsonc` (`sloppy-imports` + `detect-cjs` enabled; import map
  `@rocket.chat/apps-engine/` → compiled engine, `@rocket.chat/apps/` → `../`; fmt: tabs,
  indentWidth 4, lineWidth 160, singleQuote). The base's lint/format/tsconfig become the single
  source the ~30 idiom diffs converge under.

## Out of scope

- **Migration ordering / history rewrite** — handled separately.
- **The nodenext migration of the main package** that would enable P2 — a future, coordinated
  multi-package effort.
