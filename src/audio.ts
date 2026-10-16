// 标准读音播放：只播正常速度，越简单越好。
// 关键：先 pause 再重置，否则连点时浏览器会把速率叠加，越点越慢。

export async function playAudio(audio: HTMLAudioElement): Promise<void> {
  audio.pause();
  audio.currentTime = 0;
  audio.playbackRate = 1;
  await audio.play();
}
