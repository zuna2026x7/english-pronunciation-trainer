import { defineConfig } from 'vite'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * 把 public/updates/manifest.json 的 version 注入 index.html 的热更新引导脚本
 * （占位符 __EptBundledVersion__），让引导脚本能在入口 JS 执行前比较
 * 热更新版与内置版。清单缺失时回落 '0.0.0'（引导脚本按无内置版处理）。
 */
function injectBundledVersion() {
  let version = '0.0.0'
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'public/updates/manifest.json'), 'utf-8'),
    )
    if (typeof manifest.version === 'string' && manifest.version) version = manifest.version
  } catch {
    // 清单缺失：回落默认值，不阻断构建
  }
  return {
    name: 'ept-inject-bundled-version',
    transformIndexHtml(html: string) {
      return html.split('__EptBundledVersion__').join(version)
    },
  }
}

export default defineConfig({
  base: './',
  resolve: {
    // onnxruntime-web 走 extern-wasm 变体（ort.wasm.min.mjs）：wasm/glue 由
    // /models/wasm/ 在运行时提供（音素学生模型 worker），不把 11MB wasm
    // 以 base64 内嵌进 worker JS。
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
  },
  plugins: [injectBundledVersion()],
})
