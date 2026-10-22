// 音素学生模型推理 Worker：onnxruntime-web 跑 student_int8.onnx（int8 蒸馏模型，122MB）。
// 结构与 whisper-worker.ts 对齐：主线程见 src/phoneme-scorer.ts，解码见 src/phoneme-decode.ts。
//
// 模型不打包进 APK：首次打分时从 speak.benext.uk/models/ 下载（带进度），
// 存 Cache API（与 Service Worker 同一存储，App 重启后仍在）；之后从缓存加载。
// 查词预热只在已缓存时加载会话，绝不在后台偷跑 122MB 流量。
// 输入契约（phonix-distill/export/README-export.md）：input_values = 原始 16kHz 波形
// （归一化已烘进图里，不要再归一化），输出 logits [batch, frames, 56]。

import * as ort from 'onnxruntime-web/wasm';
import { decodeLogits } from './phoneme-decode';

/** WebView 无跨源隔离，ORT 先单线程（改线程数只改这里）；SIMD 保持开。 */
export const PHONEME_ORT_THREADS = 1;

const MODEL_FILE = 'student_int8.onnx';
const MODEL_BYTES = 121937849; // 服务端文件确切字节数，尺寸不对按损坏处理
const CACHE_NAME = 'phoneme-student-v1';

function isCapacitorLoc(): boolean {
  const loc = self.location;
  return loc.hostname === 'localhost' && loc.protocol === 'https:' && !loc.port;
}

function siteBase(): string {
  return self.location.pathname.startsWith('/pronunciation/') ? '/pronunciation' : '';
}

function modelUrl(): string {
  // App 内 origin 是 https://localhost（本地资源里没有这个模型），用绝对地址下载；
  // 网页版同源取 /models/（与 Whisper 模型同一托管目录）。
  if (isCapacitorLoc()) return `https://speak.benext.uk/models/${MODEL_FILE}`;
  return `${self.location.origin}${siteBase()}/models/${MODEL_FILE}`;
}

function wasmPaths(): string {
  return `${self.location.origin}${siteBase()}/models/wasm/`;
}

type ProgressFn = (msg: string) => void;

async function cacheLookup(): Promise<ArrayBuffer | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(modelUrl());
    if (!hit) return null;
    const buf = await hit.arrayBuffer();
    if (buf.byteLength !== MODEL_BYTES) {
      await cache.delete(modelUrl()).catch(() => {});
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

async function downloadModel(onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const url = modelUrl();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`音素模型下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || MODEL_BYTES;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      got += value.byteLength;
      onProgress?.(`下载音素模型 ${Math.min(99, Math.round((got / total) * 100))}%`);
    }
  }
  const flat = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    flat.set(c, off);
    off += c.byteLength;
  }
  if (flat.byteLength !== MODEL_BYTES) {
    throw new Error(`音素模型尺寸异常 ${flat.byteLength} != ${MODEL_BYTES}`);
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      url,
      new Response(flat.slice().buffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
  } catch {
    // 缓存失败不致命：本次会话照常用，下次再下
  }
  onProgress?.('');
  return flat.buffer;
}

interface SessionInfo {
  session: ort.InferenceSession;
  loadMs: number;
}

let sessionPromise: Promise<SessionInfo> | null = null;

function ensureSession(onProgress?: ProgressFn): Promise<SessionInfo> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const t0 = performance.now();
      ort.env.wasm.wasmPaths = wasmPaths();
      ort.env.wasm.numThreads = PHONEME_ORT_THREADS;
      try {
        (ort.env.wasm as unknown as { simd?: boolean }).simd = true;
      } catch {
        // 旧版 ORT 无此开关则忽略
      }
      const buffer = (await cacheLookup()) ?? (await downloadModel(onProgress));
      const session = await ort.InferenceSession.create(new Uint8Array(buffer), {
        executionProviders: ['wasm'],
      });
      return { session, loadMs: Math.round(performance.now() - t0) };
    })();
    // 失败后清掉缓存的 Promise，下次打分可重试（模型缓存已落盘时重试只付加载成本）
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

/** 预热：只在模型已缓存时加载会话；没缓存直接返回 false，绝不触发下载。 */
async function preloadSession(): Promise<boolean> {
  if (sessionPromise) {
    await sessionPromise;
    return true;
  }
  const cached = await cacheLookup();
  if (!cached) return false;
  await ensureSession();
  return true;
}

function errMsg(err: unknown): string {
  return (err as Error)?.message || String(err);
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data;
  if (!data || typeof data.type !== 'string') return;
  const progress: ProgressFn = (msg) => self.postMessage({ type: 'progress', id: data.id, msg });

  if (data.type === 'preload') {
    try {
      const cached = await preloadSession();
      self.postMessage({ type: 'ready', id: data.id, cached });
    } catch (err) {
      sessionPromise = null;
      self.postMessage({ type: 'error', id: data.id, error: errMsg(err) });
    }
    return;
  }

  if (data.type === 'score') {
    const { id, audio } = data as { id: number; audio: Float32Array };
    try {
      const { session, loadMs } = await ensureSession(progress);
      const t0 = performance.now();
      const input = new ort.Tensor('float32', audio, [1, audio.length]);
      const out = await session.run({ input_values: input });
      const logits = out.logits;
      const inferMs = Math.round(performance.now() - t0);
      const dims = logits.dims;
      const tokens = decodeLogits(logits.data as Float32Array, dims[1], dims[2]);
      self.postMessage({ type: 'result', id, tokens, loadMs, inferMs });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: errMsg(err) });
    }
    return;
  }
};
