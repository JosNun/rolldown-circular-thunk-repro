// require() forces lib-impl into WrapKind::Esm. This is what makes Rolldown
// emit the lazy-init wrapper that defers the `const fn = () => 1` assignment.
declare const require: (id: string) => unknown;
console.log(require("./lib-impl"));
