// onnxruntime-web 的 package.json "exports" 没有 types 条件，TS 按 exports 解析时
// 找不到包自带的 types.d.ts（其内容即 re-export onnxruntime-common）。这里补同样声明，
// 只针对实际用到的 /wasm 子路径（phoneme-worker.ts）。
declare module 'onnxruntime-web/wasm' {
  export * from 'onnxruntime-common';
}
