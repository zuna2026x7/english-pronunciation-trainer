// Whisper 推理放 Web Worker —— 评分时主线程不被阻塞，UI（按钮、切词、设置）保持响应。
// 主线程见 src/whisper.ts（Worker 客户端），通过 postMessage 通信。
// 注意：Worker 里没有 window，用 self.location；transformers 用静态 import，让 Vite 打包成独立 Worker chunk。

import { pipeline, env } from '@huggingface/transformers';

let pipePromise: Promise<any> | null = null;

function getPipeline(onProgress?: (msg: string) => void) {
  if (!pipePromise) {
    pipePromise = (async () => {
      // 与旧 whisper.ts 相同的 env 配置，只是 window.location → self.location。
      const loc = self.location;
      const isCapacitor =
        loc.hostname === 'localhost' && loc.protocol === 'https:' && !loc.port;
      const isSelfHosted =
        loc.hostname === '198.200.49.120' ||
        /\.benext\.uk$/.test(loc.hostname) ||
        /\.chuangkai\.cloud$/.test(loc.hostname) ||
        loc.pathname.startsWith('/pronunciation/');
      if (isSelfHosted || isCapacitor) {
        const base =
          !isCapacitor && loc.pathname.startsWith('/pronunciation/') ? '/pronunciation' : '';
        env.remoteHost = `${loc.origin}${base}/models`;
        (env as any).backends = (env as any).backends || {};
        (env as any).backends.onnx = (env as any).backends.onnx || {};
        (env as any).backends.onnx.wasm = (env as any).backends.onnx.wasm || {};
        (env as any).backends.onnx.wasm.wasmPaths = `${loc.origin}${base}/models/wasm/`;
      }
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      if (onProgress) onProgress('加载模型');
      const pipe = await (pipeline as any)('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        quantized: true,
        progress_callback: (p: any) => {
          if (!onProgress) return;
          if (p?.status === 'progress' && typeof p?.progress === 'number') {
            onProgress(`加载模型 ${Math.round(p.progress)}%`);
          } else if (p?.status) {
            onProgress('');
          }
        },
      });
      if (onProgress) onProgress('');
      return pipe;
    })();
  }
  return pipePromise;
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data;
  if (!data || typeof data.type !== 'string') return;
  const progress = (msg: string) => self.postMessage({ type: 'progress', id: data.id, msg });

  if (data.type === 'preload') {
    try {
      await getPipeline(progress);
      self.postMessage({ type: 'ready', id: data.id });
    } catch (err) {
      pipePromise = null;
      self.postMessage({ type: 'error', id: data.id, error: (err as Error)?.message || String(err) });
    }
    return;
  }

  if (data.type === 'transcribe') {
    const { id, audio } = data;
    try {
      const pipe = await getPipeline(progress);
      progress('识别中');
      // 英文专用模型（whisper-tiny.en）不接受 language/task 参数，传入会报
      // “Cannot specify `task` or `language` for an English-only model”。不传即可。
      const out = await pipe(audio, { chunk_length_s: 30, stride_length_s: 5 });
      const text: string = typeof out?.text === 'string' ? out.text : '';
      const cleaned = text.trim().toLowerCase().replace(/[^a-z' -]+/g, ' ').replace(/\s+/g, ' ').trim();
      self.postMessage({ type: 'result', id, text: cleaned });
    } catch (err) {
      pipePromise = null;
      self.postMessage({ type: 'error', id, error: (err as Error)?.message || String(err) });
    }
    return;
  }
};
