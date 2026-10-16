// 标准读音三档播放：变速不变调。
// 用 <audio> + preservesPitch（浏览器内置 WSOLA），避免 Web Audio playbackRate 变调。

export function setPreservesPitch(audio: HTMLAudioElement): void {
  const a = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  a.preservesPitch = true;
  a.mozPreservesPitch = true;
  a.webkitPreservesPitch = true;
}

export async function playAtRate(audio: HTMLAudioElement, rate: number): Promise<void> {
  setPreservesPitch(audio);
  audio.playbackRate = rate;
  // 从头播，保证三档对比一致
  audio.currentTime = 0;
  await audio.play();
}

export const RATES = {
  normal: 1.0,
  slow: 0.65,
  verySlow: 0.4,
} as const;
