// require() forces lib-impl into WrapKind::Esm.
declare const require: (id: string) => unknown;
console.log(require("./lib-impl"));
