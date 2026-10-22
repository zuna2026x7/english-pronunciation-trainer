// 服务器打分通道：把录音发到自建音素打分服务（phonix-score，fp32 学生模型，
// 与本地 int8 是同一模型的全精度版），返回同一评估词元空间的音素序列，
// 渲染走 main.ts 与本地学生模型共用的音素渲染，同一录音两种通道长相一致。
// 任一环节失败（超时 / 非 200 / 响应异常）都 reject，调用方静默回落下一通道。
//
// 传输选型（Capacitor 7.6）：
// - 页面源是 https://localhost，服务端点是裸 IP 的明文 HTTP —— 普通 fetch
//   会被 mixed-content / cleartext 策略拦，必须走 Capacitor 原生 HTTP。
// - 但原生桥把插件调用参数 JSON 序列化后过桥（native-bridge 的
//   androidBridge.postMessage(JSON.stringify(...))），FormData 会被序列化成 {}，
//   multipart 过不了桥（桥只在被全局启用的 fetch/XHR 补丁里才转换 FormData，
//   本 App 不启用那个补丁，避免影响其它请求）。所以走 base64 JSON：
//   服务端 /api/score-json 与 /api/score（multipart）共用同一打分逻辑，
//   响应 JSON 形状完全一致。录音只有几十 KB，base64 的 +33% 可忽略。
// - 桌面/网页（无原生桥）时 CapacitorHttp 自动回落其 Web 实现（fetch+JSON），
//   同一套代码可直接调试。

import { CapacitorHttp } from '@capacitor/core';

export interface ServerScoreResult {
  /** 识别到的音素序列（评估词元空间，与本地学生模型解码同空间）。 */
  tokens: string[];
  /** 服务端返回的分数（0–100 浮点）；界面分数走与本地相同的客户端计算，此值仅备查。 */
  serverScore: number;
  /** 服务端耗时（响应 latency_ms：解码 + 推理 + 打分）。 */
  serverMs: number;
  /** 客户端端到端耗时（base64 转码 + 传输 + 等服务端）。 */
  totalMs: number;
}

const SCORE_JSON_URL = 'http://121.37.131.76/api/score-json';
/** 端到端硬超时：原生请求无法取消，超时只是不再等（迟到的结果直接丢弃）。 */
const TIMEOUT_MS = 4000;

function extForBlob(blob: Blob): string {
  const t = (blob.type || '').toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('mp4') || t.includes('aac') || t.includes('m4a')) return 'm4a';
  if (t.includes('wav')) return 'wav';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  return 'webm';
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

interface ScoreJsonResponse {
  recognized_phonemes?: unknown;
  score?: unknown;
  latency_ms?: unknown;
}

/** 用服务器给一段录音打分（音素级）。blob 是录音原文件（webm/opus 或 AAC）。 */
export async function scoreWithServer(
  blob: Blob,
  word: string,
  targetIpa: string,
): Promise<ServerScoreResult> {
  const t0 = performance.now();
  const audio_base64 = await blobToBase64(blob);
  const request = CapacitorHttp.post({
    url: SCORE_JSON_URL,
    headers: { 'Content-Type': 'application/json' },
    data: { word, target_ipa: targetIpa, audio_base64, audio_ext: extForBlob(blob) },
    responseType: 'json',
    connectTimeout: TIMEOUT_MS,
    readTimeout: TIMEOUT_MS,
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`服务器打分超时 ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  });
  const res = await Promise.race([request, timeout]);
  const totalMs = Math.round(performance.now() - t0);
  if (res.status !== 200) {
    throw new Error(`服务器打分 HTTP ${res.status}`);
  }
  const data = (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as
    | ScoreJsonResponse
    | null;
  if (!data || !Array.isArray(data.recognized_phonemes)) {
    throw new Error('服务器打分响应异常');
  }
  const tokens = data.recognized_phonemes.filter(
    (t): t is string => typeof t === 'string',
  );
  if (tokens.length !== data.recognized_phonemes.length) {
    throw new Error('服务器打分响应异常');
  }
  return {
    tokens,
    serverScore: Number(data.score) || 0,
    serverMs: Number(data.latency_ms) || 0,
    totalMs,
  };
}
