// Runtime verification: load the built dashboard chunk and call its exports.
// If d3-scale's lazy-init wrappers weren't invoked, compute() throws.
import { execSync } from 'child_process';
import { copyFileSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

// Stage the built chunks as .mjs so Node will load them as ESM despite our
// commonjs package.json.
const stage = '/tmp/rolldown-d3-repro-stage';
execSync(`rm -rf ${stage} && mkdir -p ${stage}`);
const distDir = './dist/assets';
for (const f of readdirSync(distDir)) {
  if (f.endsWith('.js')) {
    copyFileSync(join(distDir, f), join(stage, f.replace(/\.js$/, '.mjs')));
  }
}
execSync(`sed -i 's/\\.js"/.mjs"/g' ${stage}/*.mjs`);

const dash = readdirSync(stage).find(f => f.startsWith('dashboard-') && f.endsWith('.mjs'));
const url = `file://${stage}/${dash}`;

// Minimal DOM stub so the vite preload helper in the index chunk doesn't crash.
globalThis.document = new Proxy(function () {}, {
  get: (_, k) => (k === Symbol.iterator ? [][Symbol.iterator].bind([]) : globalThis.document),
  apply: () => globalThis.document,
  construct: () => globalThis.document,
});
globalThis.window = globalThis;
globalThis.HTMLElement = function () {};
globalThis.location = { search: '' };

const mod = await import(url);
console.log('exports:', Object.keys(mod));
try {
  const r = mod.default();
  console.log(`✅ compute() returned ${r} — no bug detected at runtime`);
  // The bundle's index chunk fires window events as part of its preload-helper
  // bootstrap; bypass that noise by exiting now.
  process.exit(0);
} catch (e) {
  console.log(`💥 CRASH: ${e.message}`);
  console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
