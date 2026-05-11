// Uses the umbrella namespace import — same shape as Baserate's
// `import { Scale } from '@visx/visx'`.
import { Lib } from "./lib-umbrella";

export function check(): number {
  const r = Lib.foo();
  if (r !== 1) {
    throw new Error(`expected foo() to return 1, got ${r}`);
  }
  return r;
}
