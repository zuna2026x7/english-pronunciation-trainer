// 离线能力：本地词表查找 + TTS 播放。
//
// 词表：public/data/cet4.json（构建脚本 scripts/build-cet4.py 从 MIT 许可的 ECDICT 生成，
// CET-4 3846 词 + 高频常用词补足到 4500 词）。运行时懒加载，Service Worker 会缓存它。
// 查不到的词返回 null，调用方走现有在线词典/Wiktionary 兜底。

import type { WordInfo } from './dictionary';

type Entry = { w: string; p: string; d: string };

let pack: Map<string, Entry> | null = null;
let packPromise: Promise<Map<string, Entry> | null> | null = null;

async function loadPack(): Promise<Map<string, Entry> | null> {
  if (pack) return pack;
  if (!packPromise) {
    packPromise = (async () => {
      try {
        // 相对路径：根路径 / 与旧 /pronunciation/ 子路径、Capacitor 的 https://localhost 都能用
        const res = await fetch('./data/cet4.json');
        if (!res.ok) return null;
        const list = (await res.json()) as Entry[];
        const m = new Map<string, Entry>();
        for (const e of list) {
          if (e?.w) m.set(e.w.toLowerCase(), e);
        }
        pack = m;
        return m;
      } catch {
        return null;
      }
    })();
  }
  return packPromise;
}

/** 本地词表查找：找到返回 WordInfo（无真人音频，播放走 TTS），找不到返回 null。 */
export async function lookupLocal(raw: string): Promise<WordInfo | null> {
  const word = raw.trim().toLowerCase();
  if (!word) return null;
  const m = await loadPack();
  const e = m?.get(word);
  if (!e) return null;
  return {
    word: e.w,
    phonetic: e.p || '',
    audio: '',
    audioSourceUrl: '',
    pos: '',
    definition: e.d || '',
    allPhonetics: e.p ? [{ text: e.p }] : [],
  };
}

/** TTS 播放（离线时用，无真人音频时兜底）。
 *  先 cancel 上一次朗读再播，避免连点时多条朗读排队叠加。
 *  rate 对应连点循环的 1.0 / 0.65 / 0.40；失败不抛，调用方不报错刷屏。 */
export function speakTTS(text: string, rate: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = Math.min(10, Math.max(0.1, rate));
      const voices = synth.getVoices();
      const en = voices.find((v) => /^en[-_]/i.test(v.lang));
      if (en) u.voice = en;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.speak(u);
    } catch {
      resolve();
    }
  });
}
