// Module-level state used by an exported function. The same pattern d3-scale
// uses for `var unit = [0, 1]` and `var index = new InternMap()`.
export function foo(): number {
  return fn();
}

const fn = (): number => 1;
