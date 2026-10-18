// 本地语音识别：Xenova/whisper-base.en via @huggingface/transformers v3（ONNX，浏览器本地跑）。
// 明确不用 Web Speech API（Chrome 里走 Google）、不用 Google Cloud Speech。
// 推理在 Web Worker（src/whisper-worker.ts）里跑，主线程不被阻塞，评分时 UI 保持响应。
// Worker 用 Vite 的 new Worker(new URL(...), {type:'module'}) 打包成独立 chunk，
// 热更新时随 OTA 下发（build-ota.py 把新增 chunk 纳入清单），不会在热更新目录 404。

export type ProgressCb = (msg: string) => void;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (text: string) => void; reject: (e: Error) => void; onProgress?: ProgressCb }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./whisper-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'progress') {
        pending.get(data.id)?.onProgress?.(data.msg);
        return;
      }
      if (data.type === 'result' || data.type === 'ready') {
        const p = pending.get(data.id);
        if (p) {
          pending.delete(data.id);
          p.resolve(data.type === 'result' ? data.text : '');
        }
        return;
      }
      if (data.type === 'error') {
        const p = pending.get(data.id);
        if (p) {
          pending.delete(data.id);
          p.reject(new Error(data.error || '识别失败'));
        }
        return;
      }
    };
    worker.onerror = (e) => {
      // Worker 启动失败（如 chunk 404）：拒绝所有等待中的请求，主线程逻辑按原有错误处理。
      for (const [, p] of pending) p.reject(new Error(e.message || 'Worker error'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

export async function transcribePCM(pcm: Float32Array, onProgress?: ProgressCb): Promise<string> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    // 不用 transferable（会 detach 原 buffer，main.ts 的 myPcm 还要给回放用）；
    // 结构化克隆拷贝一份，录音只有几秒（约 100KB），拷贝开销可忽略。
    w.postMessage({ type: 'transcribe', id, audio: pcm });
  });
}

/** 预热模型（用户点查词后可在后台预加载，点评分时更快）。失败不抛，评分时再试。 */
export function warmupModel(onProgress?: ProgressCb): void {
  try {
    const w = getWorker();
    const id = nextId++;
    pending.set(id, { resolve: () => {}, reject: () => {}, onProgress });
    w.postMessage({ type: 'preload', id });
  } catch {
    // 预热失败不抛，评分时再试。
  }
}
