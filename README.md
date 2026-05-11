# Rolldown emits lazy ESM init thunks that aren't invoked at chunk top-level

A reproduction (mechanism + analysis) of a Vite 8 / Rolldown bug. In our
production build, Rolldown emits a chunk that:

- defines 100+ lazy ESM module-init thunks (`var X = __esmMin(() => { ... })`)
- exports a handful as named exports for cross-chunk consumers
- emits **no top-level invocation** of those thunks

When the chunk's own exported component runs (called by React rendering),
it reads module-level state that was wrapped behind a thunk that nobody
ever called — and crashes with `TypeError: Cannot read properties of
undefined (reading 'length')` (at `d3-scale`'s `continuous.js:78` inside
`Math.min(domain.length, range.length)`, where `domain = range = unit` and
`unit` is the unset `[0, 1]`).

## Reproduce the wrapping mechanism

```sh
yarn install
yarn build
node test-crash.mjs
```

`test-crash.mjs` runs a hand-rolled version of what Rolldown emits and
demonstrates the runtime symptom in isolation:

```
Calling scaleLinear()...
CRASH: Cannot read properties of undefined (reading 'length')
```

Inspecting `dist/assets/*.js` after `yarn build` shows Rolldown's
lazy-init thunk pattern from
[`crates/rolldown/tests/rolldown/issues/rolldown_vite_289`](https://github.com/rolldown/rolldown/tree/main/crates/rolldown/tests/rolldown/issues/rolldown_vite_289):

```js
var fn;                                                  // module-level binding
var init_lib_impl = __esmMin(() => { fn = () => 1; });   // deferred init
function foo() { return fn(); }                          // exported function
```

In this minimal form Rolldown also emits the inline init call at every
import site, so `foo()` works. We hit the same wrap shape in production,
**except the inline init call is missing for some chunks/imports** and
`foo()` (in our case `scaleLinear()`) crashes.

## The trigger

[Per Rolldown's link-stage docs](https://www.atriiy.dev/blog/rolldown-link-stage-symbol-linking-resolution) and the source at
`crates/rolldown/src/stages/link_stage/determine_module_exports_kind.rs`,
`WrapKind::Esm` is set when an `ImportKind::Require` reaches a module
with `ExportsKind::Esm`. Our consumer package has `"type": "commonjs"`,
which is how Vite/Rolldown propagates CJS-style import semantics down
through dependencies. Anywhere a `require()` reaches an ESM module
(directly or transitively via CJS deps like react/MUI/emotion), Rolldown
wraps that ESM module body in a lazy-init thunk.

## Workaround: `output.strictExecutionOrder: true` makes the crash go away

```ts
build: {
  rolldownOptions: {
    output: { strictExecutionOrder: true },
  },
},
```

This makes Rolldown emit a runtime helper that invokes every chunk's
init thunks in declaration order, which is what the missing inline
inits were supposed to do.

Trade-off in our production build: main entry chunk inflated ~70%
(572 kB → 967 kB), because the option forces eager init everywhere and
prevents downstream code-splitting / dead-code elimination decisions.

A targeted `renderChunk` plugin that scans for `var X = <helper>(() => {...})`
thunks in affected chunks and appends `X1(),X2(),…,Xn();` after the
`export` statement gets the same correctness without the size hit.
We're shipping that as a stopgap.

## Smoking gun in our production build: an orphan chunk

Inspecting the build artifacts I noticed an `esm.zzz-Uu7QKPL.js` chunk
that **nothing imports**:

```sh
$ for f in dist/*.js; do
    name=$(basename "$f")
    # count importers (other dist chunks that mention this filename)
    cnt=$(grep -lF "$name" dist/*.js 2>/dev/null | grep -v "$name\$" | wc -l)
    if [ "$cnt" -eq 0 ] && [ "$name" != "main-entry.js" ]; then
      echo "orphan: $name"
    fi
  done
orphan: esm.zzz-Uu7QKPL.js
```

Its full content is 308 bytes:

```js
import { Za as e } from "./createSvgIcon.zzz<hash>.js";
import { i as t, n, r, t as i } from "./dashboard.zzz<hash>.js";
var a = e(() => {}), o = e(() => {}), s = e(() => {}),
    c = e(() => {}), l = e(() => {});
e(() => { t(), r(), a(), o(), s(), c(), l() });   // ← thunk DEFINED, never invoked (no trailing ())
var u = e(() => {});
e(() => { i(), u(), n() });                       // ← thunk DEFINED, never invoked
```

According to the chunk's sourcemap the modules in it are:

- `@visx/scale/esm/index.js` (the barrel — pure re-exports)
- `@visx/shape/esm/index.js` (same)
- 6 type-only files (`export {}`) from `@visx/{scale,shape}/esm/types/*`

So:

1. **Rolldown extracted the visx barrel files into a chunk that no one
   imports.** Whatever chunking heuristic put them there appears to
   assume the chunk would be loaded, but the actual graph never
   includes it.
2. **The barrel chunk's body is two thunk-creating expressions without
   a trailing `()`.** `e(() => {…})` creates a memoized thunk and
   discards it — the body never runs.
3. **The dashboard chunk exports `i, n, r, t` (its d3-scale and visx
   init thunks) presumably so this orphan can invoke them.** It doesn't,
   so they never run, so `dt = [0, 1]` never executes, so `scaleLinear()`
   crashes.

In other words: the orphan chunk is the (intended) link in the chain
that calls dashboard's init thunks. The chain is broken in two places
at once — the chunk is unreachable, *and* its body wouldn't invoke
anything even if it were loaded.

## What I think Rolldown should do

1. **Always emit a top-level invocation for every init thunk in a chunk.**
   The thunks memoize, so the per-call cost is one call per module the
   first time, then nothing. That's effectively what
   `strictExecutionOrder: true` already does, but its bundle-size impact
   suggests the wrong layer.
2. **Always invoke `e(() => {…})` expressions.** Emitting
   `e(() => {…});` (no trailing `()`) just creates and discards a thunk —
   the body never runs. Whatever Rolldown emission path produced the
   orphan chunk's body has a missing call.
3. **Detect and remove unreferenced chunks during chunk-graph
   optimization.** An entry chunk that nothing imports (and isn't a
   user-defined entry / emitted chunk / pure facade) shouldn't be
   shipped. The chunk-optimizer already has facade-elimination logic in
   `crates/rolldown/src/stages/generate_stage/chunk_optimizer.rs`; this
   case slipped through.

## What this repro contains

- `src/lib-impl.ts` — exports `foo()` that reads a module-level `const fn`
- `src/lib-barrel.ts` — `export { foo } from './lib-impl'` (re-export barrel)
- `src/lib-umbrella.ts` — `export * as Lib from './lib-barrel'` (namespace
  re-export, mirroring `@visx/visx/esm/index.js`)
- `src/trigger-error.ts` — imports `Lib.foo()` via the umbrella, asserts
  it returns 1
- `src/trigger-other.ts` — second consumer of the umbrella, same shape
- `src/trigger-wrapping.ts` — `require('./lib-impl')` — the wrap trigger
- `src/main.ts` — picks a route based on `location.search`
- `package.json` — note `"type": "commonjs"`
- `test-crash.mjs` — hand-rolled emission that **does** crash, to show
  the runtime symptom

After `yarn build`, the emitted chunks show the lazy thunk pattern.
The chunks themselves don't crash in this minimal form because Rolldown
also emits a top-level invocation that runs everything.

## What I couldn't reduce

The production build's dashboard chunk has the same wrap pattern **but
no top-level invocation**, and there's an orphan chunk whose body is
also missing thunk invocations. I couldn't reduce that combination to
a minimal trigger. Things that don't cause it on their own:

- `"type": "commonjs"` alone → wrap happens, init still emitted, no crash
- `+` two lazy routes sharing wrapped modules → still works
- `+` namespace re-export barrel (`export * as X from`) → still works
- `+` umbrella pattern (separate chunk per route) → still works
- `+` emotion `styled` + MUI imports in the same chunk → still works
- `+` larger chunk graphs (5-50 lazy splits) → still works

It correlates strongly with:

- many lazy `import()`s (~150 in our build)
- CJS-typed workspace packages importing visx/d3 via aliases
- the orphan chunk emission documented above

I can share the production build's dashboard chunk + orphan privately
if helpful.

## Production crash, for reference

```
TypeError: Cannot read properties of undefined (reading 'length')
    at u (continuous.js:78:29)            // Math.min(domain.length, range.length)
    at Ri (continuous.js:124:23)          // continuous()
    at Aa (linear.js:61:15)               // d3-scale linear()
    at hs (linear.js:5:28)                // visx createLinearScale
    at <Component> (activityChartReport.tsx:384)
```

Second flavor, from `scaleOrdinal`:

```
TypeError: Zt is not a constructor       // class extends Map (InternMap), defined inside an uncalled m(() => {...})
    at dn (ordinal.js:7:15)               // var index = new InternMap()
```

## Versions

- `vite ^8.0.12` (Rolldown bundled)
- Node 24, Yarn 4.12
- `"type": "commonjs"` in `package.json` — the wrap trigger
