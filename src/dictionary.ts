// 自有服务器反代判断：
// - GitHub Pages / 其他外站：直接走 https://api.dictionaryapi.dev
// - 自有服务器（IP 或 *.benext.uk / *.chuangkai.cloud，或 /pronunciation/ 路径）：
//   走同源反代 /pronunciation/api/dict/ -> https://api.dictionaryapi.dev/
//   这样在 GitHub 被挡的区域，用户只访问自有域名即可用词典 + 音频。
export function isSelfHosted(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return (
    h === '198.200.49.120' ||
    /\.benext\.uk$/.test(h) ||
    /\.chuangkai\.cloud$/.test(h) ||
    window.location.pathname.startsWith('/pronunciation/')
  );
}

function dictBase(): string {
  return isSelfHosted() ? '/pronunciation/api/dict' : 'https://api.dictionaryapi.dev';
}

/** 把词典返回的音频 URL 转成同源反代 URL（仅自有服务器时），避免浏览器直连被挡的源站。 */
function rewriteAudioUrl(url: string): string {
  if (!url) return url;
  if (!isSelfHosted()) return url;
  // 词典音频形如 https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3
  // 反代：/pronunciation/api/dict/media/... -> https://api.dictionaryapi.dev/media/...
  const m = url.match(/^https:\/\/api\.dictionaryapi\.dev\/(.+)$/);
  if (m) return `/pronunciation/api/dict/${m[1]}`;
  return url;
}

export interface WordInfo {
  word: string;
  phonetic: string; // 如 /həˈloʊ/，可能为空
  audio: string; // 可能为空（首选 dictionaryapi 音频）
  audioSourceUrl?: string; // 词典音频的 Wikimedia Commons 源页面，如 https://commons.wikimedia.org/w/index.php?curid=9021983（用于兜底）
  pos: string;
  definition: string;
  allPhonetics: { text?: string; audio?: string; sourceUrl?: string }[];
}

export async function fetchWord(raw: string): Promise<WordInfo> {
  const word = raw.trim().toLowerCase();
  if (!word) throw new Error('请输入单词');
  if (!/^[a-z][a-z' -]*$/i.test(word)) throw new Error('请输入英文单词（仅字母、连字符、撇号）');
  const res = await fetch(`${dictBase()}/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (res.status === 404) throw new Error(`词典里没找到 “${word}”，请检查拼写`);
  if (!res.ok) throw new Error(`词典请求失败（HTTP ${res.status}），请稍后重试`);
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry) throw new Error('词典返回为空');
  const phonetics: { text?: string; audio?: string; sourceUrl?: string }[] = entry.phonetics ?? [];
  // 优先选同时有音标和音频的，其次有音频的，其次有音标的
  const withBoth = phonetics.find((p) => p.text && p.audio);
  const withAudio = phonetics.find((p) => p.audio);
  const withText = phonetics.find((p) => p.text);
  const chosen = withBoth ?? withAudio ?? withText;
  const phonetic = entry.phonetic ?? chosen?.text ?? '';
  const audio = rewriteAudioUrl(withAudio?.audio ?? chosen?.audio ?? '');
  const audioSourceUrl = withAudio?.sourceUrl ?? chosen?.sourceUrl ?? '';
  const meaning = entry.meanings?.[0];
  const def = meaning?.definitions?.[0]?.definition ?? '';
  return {
    word: entry.word ?? word,
    phonetic,
    audio,
    audioSourceUrl,
    pos: meaning?.partOfSpeech ?? '',
    definition: def,
    allPhonetics: phonetics,
  };
}

/**
 * Wikimedia Commons 兜底音频：
 * dictionaryapi 的 /media/*.mp3 曾出现 Cloudflare 522 / 超时（2026-10-16 实测：JSON 正常，media 全超时）。
 * 而 Commons 本身正常。词典返回的 sourceUrl 指向 Commons 文件页（如 curid=9021983 -> File:En-uk-hello.ogg），
 * 用 Commons API 解析出直链 upload.wikimedia.org/...ogg，浏览器可直接播放（ogg）。
 * 自有服务器时走同源反代 /pronunciation/api/wikimedia/ 与 /pronunciation/api/commons/，避免直连被挡。
 */
export async function fetchWikimediaAudio(sourceUrl: string): Promise<string> {
  if (!sourceUrl) throw new Error('无 Wikimedia 源链接');
  const m = sourceUrl.match(/[?&]curid=(\d+)/);
  if (!m) throw new Error('无法从 sourceUrl 解析 curid');
  const pageid = m[1];
  const apiBase = isSelfHosted()
    ? '/pronunciation/api/commons/w/api.php'
    : 'https://commons.wikimedia.org/w/api.php';
  const url = `${apiBase}?action=query&prop=imageinfo&iiprop=url&format=json&pageids=${pageid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Commons API 失败（HTTP ${res.status}）`);
  const data = await res.json();
  const pages = data?.query?.pages ?? {};
  const page = pages[pageid] ?? Object.values(pages)[0] as any;
  const rawUrl: string | undefined = page?.imageinfo?.[0]?.url;
  if (!rawUrl) throw new Error('Commons 未返回音频直链');
  // 去掉 Commons 的 utm 参数，保持干净 URL
  const clean = rawUrl.split('?')[0];
  if (!isSelfHosted()) return clean;
  // upload.wikimedia.org/wikipedia/commons/4/48/En-uk-hello.ogg -> /pronunciation/api/wikimedia/wikipedia/commons/4/48/En-uk-hello.ogg
  const mu = clean.match(/^https:\/\/upload\.wikimedia\.org\/(.+)$/);
  if (mu) return `/pronunciation/api/wikimedia/${mu[1]}`;
  return clean;
}

/** 识别词的音标：用于把 Whisper 转写结果转成 IPA 再对齐。查不到则返回空，由调用方走拼写兜底。 */
export async function fetchPhoneticFor(word: string): Promise<string> {
  try {
    const info = await fetchWord(word);
    return info.phonetic;
  } catch {
    return '';
  }
}
