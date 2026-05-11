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

The runtime symptom and exact stack are documented at the bottom of this
README. Reproducing the wrapping mechanism in a minimal form is easy
(this repro). Reproducing the missing-init-call case in a minimal form is
harder — see the section *What we couldn't reduce* below.

## Reproduce

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

Inspecting `dist/assets/index-*.js` shows the wrap pattern Rolldown
emits when CJS `require()` reaches an ESM module:

```js
var fn;                                          // module-level binding (was const fn = () => 1)
var init_lib_impl = __esmMin(() => { fn = () => 1; });   // deferred init
function foo() { return fn(); }                  // exported function — reads `fn`
```

This pattern is from Rolldown's own test suite
(`crates/rolldown/tests/rolldown/issues/rolldown_vite_289/`), where it
verifies the init **is** called inline at the import location, so `foo()`
works. We hit the same pattern in production, except the inline init
call is **missing** and `foo()` (in our case `scaleLinear()`) crashes.

## The trigger

[Per Rolldown's link-stage docs](https://www.atriiy.dev/blog/rolldown-link-stage-symbol-linking-resolution)
and the source at
`crates/rolldown/src/stages/link_stage/determine_module_exports_kind.rs`,
`WrapKind::Esm` is set when an `ImportKind::Require` reaches a module
with `ExportsKind::Esm`. Our consumer package has `"type": "commonjs"`,
which causes Vite/Rolldown to treat its imports as CJS-style for interop
purposes — every ESM module the package transitively requires gets
wrapped.

In this repro:

- `src/trigger-wrapping.ts` does `require('./lib-impl')`, which marks
  `lib-impl` as `WrapKind::Esm`
- `wrap_module_recursively` then propagates the wrap into every module
  `lib-impl` imports (and so on transitively)
- The chunk emits all of those modules with lazy-init thunk bodies

In production we don't write `require()` directly; the chain comes from
CJS dependencies (e.g. MUI / emotion / react-transition-group) issuing
`require()` calls that transitively reach visx → d3-scale → d3-array.

## Workaround: `output.strictExecutionOrder: true` makes the crash go away

Setting

```ts
build: {
  rolldownOptions: {
    output: { strictExecutionOrder: true },
  },
},
```

in `vite.config.ts` makes the bug disappear. Rolldown then injects a
runtime helper that invokes every chunk's init thunks in declaration
order, which is what the missing inline inits were supposed to do.
Trade-off: bundle size grows substantially (in our production build, the
main entry chunk inflated ~70%, from 572 kB to 967 kB, even with no other
changes), because the option forces eager init everywhere and prevents
some downstream code-splitting / dead-code elimination decisions.

A targeted `renderChunk` plugin that scans for `var X = <helper>(() => {...})`
thunks in affected chunks and appends `X1(),X2(),…,Xn();` after the chunk's
`export` statement gets the same correctness without the size hit. We're
shipping that as a stopgap; see *Our workaround* below.

## What we think Rolldown should do

1. **Always emit a top-level invocation for every init thunk in a chunk.**
   The thunks memoize, so the per-call cost is one call per module the
   first time, then nothing. That's effectively what
   `strictExecutionOrder: true` already does — but its bundle-size impact
   suggests the wrong layer.
2. **Insert the inline `init_X();` call at every cross-chunk import
   site** where the importee is wrapped, the same way it does for
   intra-chunk imports today
   (`crates/rolldown/src/module_finalizers/mod.rs` →
   `transform_or_remove_import_export_stmt` →
   `WrapKind::Esm` branch).
3. **Don't let an orphan chunk's static imports inform chunking decisions
   in its "producer".** In our build, the only chunk that imports the
   dashboard chunk's exported thunks is itself an orphan
   (`esm.zzz-Uu7QKPL.js` — never imported by anything else); Rolldown
   appears to skip the dashboard chunk's IIE based on that orphan's
   imports, but the orphan never loads at runtime.

## Our workaround (production)

A small Vite plugin that, in `renderChunk`, finds every
`var X = <helper>(() => {...})` thunk in the chunk and appends
`X1(),X2(),…,Xn();` after the `export` statement. Scoped to chunks that
import `d3-*`, `internmap`, or `@visx/*`. Functionally a per-chunk
`strictExecutionOrder` without the global bundle-size hit. Source
available on request.

## What this repro contains

- `src/main.ts` — entry with two lazy routes:
  `import('./trigger-error')` and `import('./trigger-wrapping')`
- `src/lib-impl.ts` — exports `foo()` that reads a module-level `const fn`
- `src/lib-index.ts` — `export * from './lib-impl'`
- `src/trigger-error.ts` — imports `foo` via `lib-index`, asserts it
  returns `1`
- `src/trigger-wrapping.ts` — `require('./lib-impl')` — the trigger
- `src/main.ts` — selects route based on `location.search`
- `package.json` — note `"type": "commonjs"`
- `test-crash.mjs` — hand-rolled emission that **does** crash, to show
  the runtime symptom

After `yarn build`, the emitted `dist/assets/index-*.js` shows the lazy
thunk pattern. The chunks themselves don't crash in this minimal form
because Rolldown also emits a top-level invocation that runs everything.
Confirmed by:

```sh
cd /tmp/runtest                              # rename .js→.mjs first
node -e "import('./trigger-error-*.mjs').then(m => console.log(m.check()))"
# → 1
```

## What we couldn't reduce

The production build's dashboard chunk has the same wrap pattern **but
no top-level invocation**. We weren't able to reduce that omission to a
minimal trigger. Things that don't seem to cause it on their own:

- `"type": "commonjs"` alone → wrap happens, init still emitted, no crash
- two lazy entries sharing wrapped modules → still works
- many sub-component files imported by one lazy entry → still works
- emotion `styled` + MUI imports in the same chunk → still works
- larger chunk graphs (5-50 lazy splits) → still works

It correlates with:

- many lazy `import()`s (~150 in our build)
- a CJS-typed workspace package importing visx/d3 via aliases
- Rolldown emitting an orphan chunk that statically imports init thunks
  from the dashboard chunk (`esm.zzz-Uu7QKPL.js`); the orphan's body
  itself has thunk-creating expressions with **no trailing `()`**:
  ```js
  e(() => { t(), r(), a(), o(), ... });   // not invoked
  ```

We can share the production build's dashboard chunk privately if
helpful.

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
