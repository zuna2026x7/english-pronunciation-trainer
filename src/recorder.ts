// 录音 + 转成 Whisper 需要的 16kHz 单声道 Float32 PCM。

import { Capacitor } from '@capacitor/core';
import { log, setState } from './logger';

/**
 * 原生录音插件（Capacitor）：用 Android MediaRecorder 直接录音，
 * 绕过 WebView getUserMedia（华为等机型上 WebView 录音不可靠，
 * 系统权限已授予仍报 NotAllowedError）。插件内部处理权限申请。
 */
interface AudioRecorderPlugin {
  startRecording(): Promise<{ format: string }>;
  stopRecording(): Promise<{ base64: string; mimeType: string; durationMs: number }>;
}

// 插件实例只注册一次（模块级缓存），避免每次 start 都调 registerPlugin
// 触发 "already registered. Cannot register plugins twice." 警告。
let nativePlugin: AudioRecorderPlugin | null = null;
let nativePluginResolved = false;

function getNativePlugin(): AudioRecorderPlugin | null {
  if (nativePluginResolved) return nativePlugin;
  nativePluginResolved = true;
  if (!Capacitor.isNativePlatform()) return null;
  try {
    nativePlugin = Capacitor.registerPlugin<AudioRecorderPlugin>('AudioRecorder');
  } catch (e) {
    log('warn', `AudioRecorder plugin unavailable: ${(e as Error)?.message || e}`);
    nativePlugin = null;
  }
  return nativePlugin;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  blob: Blob | null = null;
  private mode: 'native' | 'web' = 'web';
  // 原生录音进行中标记（start 成功后 true，stop 后 false）
  private nativeActive = false;

  async start(): Promise<void> {
    this.chunks = [];
    this.blob = null;
    this.mode = 'web';
    // App 端优先原生录音；插件缺失（旧 APK）时回落到 getUserMedia。
    // 权限被用户拒绝时直接抛错，不回落（避免二次弹授权框）。
    const plugin = getNativePlugin();
    if (plugin) {
      try {
        const res = await plugin.startRecording();
        this.mode = 'native';
        this.nativeActive = true;
        setState('mic', `native recording (${res.format})`);
        log('log', `native recording started: ${res.format}`);
        return;
      } catch (e) {
        const msg = `${(e as Error)?.message || e}`;
        if (msg.includes('not implemented')) {
          // 插件未编进 APK（旧版）：回落 getUserMedia
          setState('mic', 'native plugin not implemented, fallback to getUserMedia');
          log('warn', 'AudioRecorder not implemented, fallback to getUserMedia');
        } else {
          // 权限拒绝 / 启动失败：直接抛错，main.ts 显示“无法录音”
          setState('mic', `native recording failed: ${msg}`);
          log('error', `native recording failed: ${msg}`);
          throw e;
        }
      }
    }
    await this.startWeb();
  }

  private async startWeb(): Promise<void> {
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
    if (this.mode === 'native') {
      const plugin = getNativePlugin();
      if (!plugin) throw new Error('原生录音插件不可用');
      try {
        const res = await plugin.stopRecording();
        this.nativeActive = false;
        const blob = base64ToBlob(res.base64, res.mimeType);
        this.blob = blob;
        setState('mic', `native recording stopped (${res.durationMs}ms, ${blob.size}B)`);
        log('log', `native recording stopped: ${res.durationMs}ms, ${blob.size} bytes, ${res.mimeType}`);
        return blob;
      } catch (e) {
        this.nativeActive = false;
        log('error', `native stop failed: ${(e as Error)?.message || e}`);
        throw e;
      }
    }
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
    if (this.mode === 'native') return this.nativeActive;
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
