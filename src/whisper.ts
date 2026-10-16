// 本地语音识别：Xenova/whisper-tiny.en via @xenova/transformers（ONNX，浏览器本地跑）。
// 明确不用 Web Speech API（Chrome 里走 Google）、不用 Google Cloud Speech。

let pipePromise: Promise<any> | null = null;

export type ProgressCb = (msg: string) => void;

function getPipeline(onProgress?: ProgressCb) {
  if (!pipePromise) {
    pipePromise = (async () => {
      const mod: any = await import('@xenova/transformers');
      const { pipeline, env } = mod;
      // 允许从 Hugging Face 远程拉模型，禁用本地模型路径（浏览器无本地文件）
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      if (onProgress) onProgress('正在加载识别模型（首次约 40MB，之后缓存）…');
      const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        quantized: true,
        progress_callback: (p: any) => {
          if (!onProgress) return;
          if (p?.status === 'progress' && typeof p?.progress === 'number') {
            onProgress(`正在加载识别模型… ${Math.round(p.progress)}%（${p.file ?? ''}）`);
          } else if (p?.status) {
            onProgress(`模型：${p.status} ${p.file ?? ''}`);
          }
        },
      });
      if (onProgress) onProgress('识别模型已就绪');
      return pipe;
    })();
  }
  return pipePromise;
}

export async function transcribePCM(pcm: Float32Array, onProgress?: ProgressCb): Promise<string> {
  const pipe = await getPipeline(onProgress);
  if (onProgress) onProgress('正在识别你的录音…');
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
