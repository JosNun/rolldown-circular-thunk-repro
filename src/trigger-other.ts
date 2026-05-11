// Second consumer of the umbrella, mirroring Baserate's pattern of multiple
// dashboard sub-components each doing `import { Scale } from '@visx/visx'`.
import { Lib } from "./lib-umbrella";

export function checkOther(): number {
  return Lib.foo();
}
