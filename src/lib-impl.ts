// Module-level const that's USED by an exported function. If the module is
// wrapped in a lazy init thunk and the thunk isn't invoked, `fn` is undefined
// when `foo()` runs.
export function foo(): number {
  return fn();
}

const fn = (): number => 1;
