// Imports foo() statically through the re-export barrel. If lib-impl's lazy
// init wasn't invoked before this code runs, foo() throws because `fn` is
// undefined.
import { foo } from "./lib-index";

export function check(): number {
  const r = foo();
  if (r !== 1) {
    throw new Error(`expected foo() to return 1, got ${r}`);
  }
  return r;
}
