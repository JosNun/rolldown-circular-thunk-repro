// Namespace re-export — same shape as @visx/visx/esm/index.js does for Scale.
// This forces Rolldown to construct a namespace object at runtime, which is
// the chunk-graph anomaly we want.
export * as Lib from "./lib-barrel";
