// 录音 + 转成 Whisper 需要的 16kHz 单声道 Float32 PCM。

import { Capacitor } from '@capacitor/core';
import { log, setState } from './logger';

/** App 端（Capacitor）：每次录音前通过原生桥接申请麦克风权限。
 *  网页端跳过；插件不存在（旧 APK）时直接放行，让 getUserMedia 去报错。 */
async function ensureMicPermission(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const plugin = Capacitor.registerPlugin<{ requestMic(): Promise<void> }>('MicPermission');
    await plugin.requestMic();
    setState('mic', 'granted');
  } catch (e) {
    setState('mic', `request failed: ${(e as Error)?.message || e}`);
    throw e;
  }
}

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  blob: Blob | null = null;

  async start(): Promise<void> {
    this.chunks = [];
    this.blob = null;
    await ensureMicPermission();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      setState('mic', 'getUserMedia ok');
      log('log', 'getUserMedia ok');
    } catch (e) {
      setState('mic', `getUserMedia failed: ${(e as Error)?.name || e}`);
      log('error', `getUserMedia failed: ${(e as Error)?.name || e} ${(e as Error)?.message || ''}`);
      throw e;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.rec.start(250);
  }

  async stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.rec) return reject(new Error('未开始录音'));
      this.rec.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        const blob = new Blob(this.chunks, { type: this.rec?.mimeType || 'audio/webm' });
        this.blob = blob;
        resolve(blob);
      };
      try {
        this.rec.stop();
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  get isRecording(): boolean {
    return !!this.rec && this.rec.state === 'recording';
  }
}

/** Blob -> 16kHz mono Float32，Whisper 输入格式。 */
export async function blobToPCM16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const buf = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const src = decoded;
    // 混成单声道
    let mono: Float32Array;
    if (src.numberOfChannels === 1) {
      mono = src.getChannelData(0).slice();
    } else {
      const len = src.length;
      mono = new Float32Array(len);
      const ch0 = src.getChannelData(0);
      const ch1 = src.getChannelData(1);
      for (let i = 0; i < len; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    }
    if (src.sampleRate === 16000) return mono;
    // 用 OfflineAudioContext 重采样到 16k
    const targetLen = Math.floor((mono.length / src.sampleRate) * 16000);
    const offline = new OfflineAudioContext(1, Math.max(1, targetLen), 16000);
    const buffer = offline.createBuffer(1, mono.length, src.sampleRate);
    buffer.getChannelData(0).set(mono);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** 简单静音检测提示：PCM 最大绝对值过小，说明没录到声音。 */
export function pcmPeak(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 16) {
    const v = Math.abs(pcm[i]);
    if (v > peak) peak = v;
  }
  return peak;
}
