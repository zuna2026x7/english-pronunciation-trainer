// 本地语音识别：Xenova/whisper-tiny.en via @huggingface/transformers v3（ONNX，浏览器本地跑）。
// 明确不用 Web Speech API（Chrome 里走 Google）、不用 Google Cloud Speech。

let pipePromise: Promise<any> | null = null;

// 失败必须清掉缓存的 rejected promise，否则之后每次评分都会直接复用同一次失败，
// 表现为“老是识别不出来”，直到换词触发 warmup 才有机会重试。

export type ProgressCb = (msg: string) => void;

function getPipeline(onProgress?: ProgressCb) {
  if (!pipePromise) {
    pipePromise = (async () => {
      const mod: any = await import('@huggingface/transformers');
      const { pipeline, env } = mod;
      // 自有服务器：模型走同源 /models/（speak 根路径部署）或 /pronunciation/models/（旧子路径部署），避免直连 huggingface.co 被挡。
      // GitHub Pages 等外站：仍走默认 Hugging Face。
      // 注意：transformers.js 用 remoteHost + remotePathTemplate 拼 URL，
      // 自有服务器上的目录结构需为 <models>/Xenova/whisper-tiny.en/resolve/main/<file>。
      const isSelfHosted =
        typeof window !== 'undefined' &&
        (window.location.hostname === '198.200.49.120' ||
          /\.benext\.uk$/.test(window.location.hostname) ||
          /\.chuangkai\.cloud$/.test(window.location.hostname) ||
          window.location.pathname.startsWith('/pronunciation/'));
      if (isSelfHosted) {
        const base = window.location.pathname.startsWith('/pronunciation/') ? '/pronunciation' : '';
        env.remoteHost = `${window.location.origin}${base}/models`;
      }
      // 允许从远程拉模型，禁用本地模型路径（浏览器无本地文件）
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      if (onProgress) onProgress('加载模型');
      const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
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

export async function transcribePCM(pcm: Float32Array, onProgress?: ProgressCb): Promise<string> {
  let pipe: any;
  try {
    pipe = await getPipeline(onProgress);
  } catch (e) {
    pipePromise = null; // 模型加载失败时清缓存，下次评分重新拉模型，而不是一直复用失败
    throw e;
  }
  if (onProgress) onProgress('识别中');
  const out = await pipe(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: 'english',
    task: 'transcribe',
  });
  const text: string = typeof out?.text === 'string' ? out.text : '';
  return text.trim().toLowerCase().replace(/[^a-z' -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 预热模型（用户点查词后可在后台预加载，点评分时更快）。失败不抛，评分时再试。 */
export function warmupModel(onProgress?: ProgressCb): void {
  getPipeline(onProgress).catch(() => {
    pipePromise = null;
  });
}
