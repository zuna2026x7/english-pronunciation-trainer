// 音素学生模型打分（本地 ONNX）：主线程客户端，推理在 phoneme-worker.ts 里跑。
// 结构与 whisper.ts 对齐：懒建 Worker、按 id 挂 pending、进度回调。
// 任一环节失败（下载 / ORT 加载 / 推理）都 reject，调用方（main.ts）静默回落 Whisper 打分。

export interface StudentScoreResult {
  /** 解码后的音素序列（已展开双元音、折叠重复）。 */
  tokens: string[];
  /** 模型下载（首次）+ ORT 会话加载耗时；已就绪时接近 0。 */
  loadMs: number;
  /** 单次推理耗时。 */
  inferMs: number;
}

type ProgressCb = (msg: string) => void;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (r: StudentScoreResult) => void;
    reject: (e: Error) => void;
    onProgress?: ProgressCb;
    /** preload 专用：worker 回 ready 时带回“模型是否已缓存/已就绪”。 */
    onReady?: (cached: boolean) => void;
  }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./phoneme-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data.type !== 'string' || typeof data.id !== 'number') return;
      const p = pending.get(data.id);
      if (data.type === 'progress') {
        p?.onProgress?.(String(data.msg ?? ''));
        return;
      }
      if (!p) return;
      pending.delete(data.id);
      if (data.type === 'result') {
        p.resolve({
          tokens: Array.isArray(data.tokens) ? (data.tokens as string[]) : [],
          loadMs: Number(data.loadMs) || 0,
          inferMs: Number(data.inferMs) || 0,
        });
      } else if (data.type === 'ready') {
        if (p.onReady) {
          p.onReady(!!data.cached);
        } else {
          // preload 完成（tokens 为空，仅占位）
          p.resolve({ tokens: [], loadMs: 0, inferMs: 0 });
        }
      } else {
        p.reject(new Error(String(data.error || 'phoneme worker error')));
      }
    };
    worker.onerror = (e) => {
      const err = new Error(`phoneme worker 启动失败：${e.message || 'unknown'}`);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

/** 用学生模型给一段 16kHz PCM 打分（音素级）。pcm 与喂 Whisper 的是同一份解码结果。 */
export function scoreWithStudent(
  pcm: Float32Array,
  onProgress?: ProgressCb,
): Promise<StudentScoreResult> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    try {
      getWorker().postMessage({ type: 'score', id, audio: pcm });
    } catch (err) {
      pending.delete(id);
      reject(err as Error);
    }
  });
}

/**
 * 探测学生模型是否“已就绪可回落”：会话已建好，或模型已下载缓存（预热即加载会话）。
 * 绝不触发下载——worker 的 preload 只读缓存。供服务器优先链路判断：
 * 未就绪时绝不能走 scoreWithStudent（那会触发 122MB 下载 + 加载，弱机上会崩）。
 */
export function probeStudentReady(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const id = nextId++;
    pending.set(id, {
      resolve: () => settle(false),
      reject: () => settle(false),
      onReady: (cached) => settle(cached),
    });
    try {
      getWorker().postMessage({ type: 'preload', id });
    } catch {
      pending.delete(id);
      settle(false);
    }
  });
}

/** 查词时预热：仅当模型已缓存才加载会话（不触发 122MB 下载）。失败静默。 */
export function warmupStudentModel(): void {
  const id = nextId++;
  pending.set(id, {
    resolve: () => {},
    reject: () => {},
  });
  try {
    getWorker().postMessage({ type: 'preload', id });
  } catch {
    pending.delete(id);
  }
}
