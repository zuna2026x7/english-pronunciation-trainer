// 播放：一个按钮，连点循环变速 1.0 → 0.65 → 0.40 → 1.0。
// 关键：先 pause 再重置，否则浏览器会把速率叠加，速度就乱了。
// 变速不变调：preservesPitch 让慢速也不变调。

export const SPEEDS = [1.0, 0.65, 0.4] as const;

export async function playAtRate(audio: HTMLAudioElement, rate: number): Promise<void> {
  const a = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  a.preservesPitch = true;
  a.mozPreservesPitch = true;
  a.webkitPreservesPitch = true;
  audio.pause();
  audio.currentTime = 0;
  audio.playbackRate = rate;
  await audio.play();
}
