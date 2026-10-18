// 离线能力：本地词表查找 + TTS 播放。
//
// 词表：public/data/cet4.json（构建脚本 scripts/build-cet4.py 从 MIT 许可的 ECDICT 生成，
// CET-4 3846 词 + 高频常用词补足到 4500 词）。运行时懒加载，Service Worker 会缓存它。
// 查不到的词返回 null，调用方走现有在线词典/Wiktionary 兜底。

import type { WordInfo } from './dictionary';
import { getOtaText, getOtaFileUrl, isOtaActive, getOtaVersion } from './updater';

type Entry = { w: string; p: string; d: string };

let pack: Map<string, Entry> | null = null;
let packPromise: Promise<Map<string, Entry> | null> | null = null;
let packOtaVersion: string | null = null;

async function loadPack(): Promise<Map<string, Entry> | null> {
  // OTA 更新了词表（ept_ota_version 变了）：丢弃旧缓存，下次查词重新加载新词表。
  // 否则 OTA 下载后、重启前查新词（如 sunny）仍走旧缓存，显示 fromLocal=false。
  const curVer = getOtaVersion();
  if (pack && packOtaVersion !== curVer) {
    pack = null;
    packPromise = null;
  }
  if (pack) return pack;
  if (!packPromise) {
    packOtaVersion = curVer;
    packPromise = (async () => {
      try {
        // 热更新版优先：App 私有目录里有新版词表时用它，否则用 APK 内置版
        const ota = await getOtaText('data/cet4.json');
        const list = ota
          ? (JSON.parse(ota) as Entry[])
          : await (async () => {
              // 相对路径：根路径 / 与旧 /pronunciation/ 子路径、Capacitor 的 https://localhost 都能用。
              // OTA 运行时 HTML 在 App 私有目录（_capacitor_file_/.../ota/index.html），
              // 相对路径会解析到 OTA 目录（没有词表）而 404；失败时回落绝对路径 /data/...（APK 内置版）。
              let res = await fetch('./data/cet4.json');
              if (!res.ok) {
                res = await fetch('/data/cet4.json');
                if (!res.ok) return null;
              }
              return (await res.json()) as Entry[];
            })();
        if (!list) return null;
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

/** 本地真人音频：构建脚本 scripts/download-audio.py 下载的 Wiktionary/词典音频，
 *  放 public/data/audio/<word>.ogg（.mp3/.wav 少数），manifest.json 记录哪些词有音频。
 *  App 内查词时优先用本地音频（离线可用），本地没有再走在线/TTS 兜底。 */
type AudioManifest = Record<string, string>;

let audioManifest: AudioManifest | null = null;
let audioManifestPromise: Promise<AudioManifest | null> | null = null;
let audioManifestOtaVersion: string | null = null;

async function loadAudioManifest(): Promise<AudioManifest | null> {
  // 同词表：OTA 更新了音频清单时丢弃旧缓存
  const curVer = getOtaVersion();
  if (audioManifest && audioManifestOtaVersion !== curVer) {
    audioManifest = null;
    audioManifestPromise = null;
  }
  if (audioManifest) return audioManifest;
  if (!audioManifestPromise) {
    audioManifestOtaVersion = curVer;
    audioManifestPromise = (async () => {
      try {
        // 热更新版 manifest 优先（新词/新音频随热更新下发），否则用 APK 内置版
        const ota = await getOtaText('data/audio/manifest.json');
        if (ota) {
          audioManifest = JSON.parse(ota) as AudioManifest;
          return audioManifest;
        }
        // 同词表：OTA 目录无 manifest 时回落绝对路径（APK 内置版）
        let res = await fetch('./data/audio/manifest.json');
        if (!res.ok) {
          res = await fetch('/data/audio/manifest.json');
          if (!res.ok) return null;
        }
        audioManifest = (await res.json()) as AudioManifest;
        return audioManifest;
      } catch {
        return null;
      }
    })();
  }
  return audioManifestPromise;
}

/** 英美拼写别名：同词异拼，词表里无音频、对方拼写有音频。
 *  音频下载脚本（scripts/download-audio.py）取 Wiktionary 音频时优先 en-us，
 *  故别名音频标注为美式录音（ui.setAudioAccentLabel），不与英式音标混淆。
 *  只收同词异拼，不收同义词 / 缩写 / 错字（如 football→soccer、cigaret→cigarette）。 */
export const AUDIO_ALIASES: Record<string, string> = {
  analyse: 'analyze',
  behaviour: 'behavior',
  favour: 'favor',
  odour: 'odor',
  vapour: 'vapor',
  centimeter: 'centimetre',
};

/** 本地真人音频 URL：热更新版优先（App 私有目录），否则 APK 内置版相对路径；无则返回 ''。 */
export async function localAudioUrl(word: string): Promise<string> {
  return (await resolveLocalAudio(word)).url;
}

/** 本地真人音频解析：直接命中清单返回直链；无直链时试英美拼写别名，aliased 标记是否走了别名。 */
async function resolveLocalAudio(word: string): Promise<{ url: string; aliased: boolean }> {
  const w = word.trim().toLowerCase();
  if (!w) return { url: '', aliased: false };
  const m = await loadAudioManifest();
  let fn = m?.[w];
  let aliased = false;
  if (!fn) {
    const target = AUDIO_ALIASES[w];
    fn = target ? m?.[target] : undefined;
    aliased = !!fn;
  }
  if (!fn) return { url: '', aliased: false };
  // 音频文件本身可能随热更新下发：热更新版存在时用它（经 convertFileSrc 的可加载 URL）
  if (isOtaActive()) {
    const otaUrl = getOtaFileUrl(`data/audio/${fn}`);
    if (otaUrl) return { url: otaUrl, aliased };
  }
  // 绝对路径：OTA 运行时相对路径会解析到 OTA 目录（无音频）而 404；绝对路径指向 APK 内置版。
  return { url: `/data/audio/${fn}`, aliased };
}

/** 本地词表查找：找到返回 WordInfo（有本地真人音频则带 audio，无则播放走 TTS），找不到返回 null。 */
export async function lookupLocal(raw: string): Promise<WordInfo | null> {
  const word = raw.trim().toLowerCase();
  if (!word) return null;
  const m = await loadPack();
  const e = m?.get(word);
  if (!e) return null;
  const { url: audio, aliased } = await resolveLocalAudio(word);
  return {
    word: e.w,
    phonetic: e.p || '',
    audio,
    audioAliased: aliased,
    audioSourceUrl: '',
    pos: '',
    definition: e.d || '',
    allPhonetics: e.p ? [{ text: e.p }] : [],
  };
}

/** 缺词上报：本地词包没有的词，上报到服务器记录，供下次打包时核查补词。
 *  只在查词时调用（main.ts lookup）；评分路径（Whisper 识别出的词）不调用，
 *  避免误识别的垃圾词进记录。上报内容只有单词 + 是否在线查到，不含任何用户信息；
 *  失败静默丢弃，不打扰用户；同词同会话只上报一次（成功后记入集合）。 */
const MISSING_WORD_RE = /^[a-z][a-z' -]*$/;
const reportedMissing = new Set<string>();

export async function reportMissingWord(raw: string, foundOnline: boolean): Promise<void> {
  const word = raw.trim().toLowerCase();
  if (!word || word.length > 64 || !MISSING_WORD_RE.test(word)) return;
  if (reportedMissing.has(word)) return;
  try {
    // 同 logger.uploadLogs：Capacitor 跑在 https://localhost，相对路径到不了服务器，用绝对地址。
    const isCapacitor =
      typeof window !== 'undefined' &&
      (!!(window as unknown as { Capacitor?: unknown }).Capacitor ||
        (window.location.hostname === 'localhost' &&
          window.location.protocol === 'https:' &&
          !window.location.port));
    const url = isCapacitor
      ? 'https://speak.benext.uk/api/log/missing-word'
      : '/api/log/missing-word';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, foundOnline: !!foundOnline }),
        signal: ctrl.signal,
      });
      if (res.ok) reportedMissing.add(word);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 上报失败静默丢弃（离线/服务器不可达时不打扰用户；下次查到同词会再试）
  }
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
