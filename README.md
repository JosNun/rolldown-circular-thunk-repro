# Rolldown emits lazy ESM module-init thunks (triggered by `"type": "commonjs"`)

A minimal reproduction of Rolldown's ESM-import-from-CJS-package wrapping
behavior. Setting `"type": "commonjs"` in `package.json` causes Rolldown to
wrap every transitively-imported ESM module's body in a memoizing lazy-init
thunk. In a sufficiently complex chunk graph the thunks never get invoked,
leaving module-level state (e.g. `d3-scale`'s `var unit = [0, 1]`) undefined
when consumer functions read it — surfacing as
`TypeError: Cannot read properties of undefined (reading 'length')`.

## What this repro shows

This is the smallest possible setup that gets Rolldown to emit the wrap:

- 1 dependency (`d3-scale`)
- 2 source files (`src/main.ts` lazy-imports `src/dashboard.ts`)
- 1 config setting: `"type": "commonjs"` in `package.json`

Run it:

```sh
yarn install
yarn build
node verify-bug.mjs        # loads the built chunk and inspects it
node test-crash.mjs        # demonstrates the runtime symptom standalone
```

`verify-bug.mjs` reports:

```
exports: [ 'default' ]
✅ compute() returned 0.5 — no bug detected at runtime
```

— i.e. `compute()` runs fine in this minimal case. But inspecting
`dist/assets/dashboard-*.js` shows the wrap pattern is present:

```js
// Rolldown emits the ESM lazy-init thunk creator at the top of the chunk's
// import target:
o = (e, t) => () => (e && (t = e(e=0)), t)

// d3-scale's `var unit = [0, 1]` ends up here instead of at module top:
var dt, ft = o(() => { b(), et(), nt(), it(), dt = [0, 1]; });

// And the transformer function reads `dt`:
function transformer() {
  var domain = dt, range = dt;       // ← undefined if ft() hasn't run
  function rescale() { return Math.min(domain.length, range.length); }
  // ...
}

// At chunk end, Rolldown emits an IIE that invokes the top-of-chunk init:
e(() => { Xt(); })();
// → Xt() → ft() → dt = [0, 1]    so by the time compute() runs, dt is set
```

If you flip `"type"` to `"module"` in `package.json` and rebuild, the wrap
goes away entirely — `var unit = [0, 1]` ends up at chunk top level, eager,
no thunk.

## When the actual crash manifests

In a production app with 100+ lazy `import()`s and a CJS workspace package,
Rolldown emits a chunk like the one above **without** the trailing
`e(() => {Xt();})();` IIE — i.e. the thunks are defined but never invoked
anywhere reachable from the chunk's exported functions. When React calls the
chunk's exported component → which calls `scaleLinear()` → which reads `dt`
→ crash.

In our case the chunk also exports 4 of its init thunks as named exports
(`gl as default, _s as i, sc as n, bs as r, mc as t`), and Rolldown emits a
**separate orphan chunk** (`esm.zzz-Uu7QKPL.js` in our build) that statically
imports those thunks and creates more thunks of its own — but is never
imported by anything else, and its own thunks have a missing trailing `()`:

```js
import { i as t, n, r, t as i } from "./dashboard.zzz<hash>.js";
var a = e(() => {}), o = e(() => {}), ...;
e(() => { t(), r(), a(), o(), ... });   // no trailing (); thunk is just defined
e(() => { i(), u(), n() });              // ditto
// no exports
```

We hypothesise Rolldown skipped the dashboard chunk's IIE because it
concluded "the orphan chunk will invoke those thunks", but the orphan chunk
is never loaded (and even if it were, it doesn't invoke its own thunks
either).

## The trigger

[Per Rolldown's link-stage docs](https://www.atriiy.dev/blog/rolldown-link-stage-symbol-linking-resolution),
`WrapKind::Esm` is set when an `ImportKind::Require` reaches a module with
`ExportsKind::Esm`. The simplest way to inject that into your import graph is
to set `"type": "commonjs"` on the consumer package — every ESM module the
package imports through dynamic chunk boundaries then gets wrapped.

## What we think Rolldown should do

1. **Always emit a top-level invocation for every init thunk in a chunk.**
   The thunks memoize, so the per-call cost is one call per module the first
   time, then nothing. This is functionally what
   `output.strictExecutionOrder: true` does globally — but the global option
   inflates main chunk size ~70%.
2. **Don't let orphan chunks influence chunking decisions in their
   "producers".** If `chunkB` statically imports init thunks from `chunkA`
   but nothing imports `chunkB`, the consumer relationship is fictional and
   `chunkA` shouldn't skip its IIE on its account.
3. **Don't emit thunk-creating expressions without an invocation.** Code like
   `e(() => { sideEffect(); });` (no trailing `()`) just creates and discards
   a thunk — the side effect never runs.

## Our workaround

A small Vite plugin in `renderChunk` that scans the chunk for
`var X = <helper>(() => {...})` thunks and appends
`X1(),X2(),…,Xn();` after the chunk's `export` statement. Scoped to chunks
that import `d3-*`, `internmap`, or `@visx/*`. Functionally a per-chunk
`strictExecutionOrder` without the global bundle-size hit.

## Versions

- `vite ^8.0.12` (Rolldown bundled)
- `d3-scale 4.0.2`
- Node 24, Yarn 4.12
- `"type": "commonjs"` in `package.json` — the trigger

## Files

- `src/main.ts` — entry; lazy `import('./dashboard')`
- `src/dashboard.ts` — uses `d3-scale`
- `package.json` — note `"type": "commonjs"`
- `vite.config.ts` — minimal config with sourcemaps
- `verify-bug.mjs` — loads the built chunk via Node and reports
- `test-crash.mjs` — hand-rolled emission that does crash, to show the symptom

If a Rolldown maintainer wants to chase the missing-IIE case directly, I can
share a private repro from the production app that does crash; the chunk
shape is documented above under "When the actual crash manifests".
