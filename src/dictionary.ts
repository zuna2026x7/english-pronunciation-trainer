// 自有服务器反代判断：
// - GitHub Pages / 其他外站：直接走 https://api.dictionaryapi.dev
// - 自有服务器（IP 或 *.benext.uk / *.chuangkai.cloud，或 /pronunciation/ 路径）：
//   走同源反代。speak.benext.uk 是专用域名，应用直接挂在根路径 /，
//   所以反代路径是 /api/dict/、/models/、/api/commons/、/api/wikimedia/（不再带 /pronunciation/ 前缀）。
//   旧的 /pronunciation/ 子路径部署仍兼容：appBase 会自动识别。
export function appBase(): string {
  if (typeof window === 'undefined') return '';
  const p = window.location.pathname;
  return p === '/pronunciation' || p.startsWith('/pronunciation/') ? '/pronunciation' : '';
}

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
  return isSelfHosted() ? `${appBase()}/api/dict` : 'https://api.dictionaryapi.dev';
}

/** 把词典返回的音频 URL 转成同源反代 URL（仅自有服务器时），避免浏览器直连被挡的源站。 */
function rewriteAudioUrl(url: string): string {
  if (!url) return url;
  if (!isSelfHosted()) return url;
  // 词典音频形如 https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3
  // 反代：/api/dict/media/... -> https://api.dictionaryapi.dev/media/...（根路径部署）
  // 或 /pronunciation/api/dict/media/...（旧子路径部署）
  const m = url.match(/^https:\/\/api\.dictionaryapi\.dev\/(.+)$/);
  if (m) return `${appBase()}/api/dict/${m[1]}`;
  return url;
}

export interface WordInfo {
  word: string;
  phonetic: string; // 如 /həˈloʊ/，可能为空
  audio: string; // 可能为空（首选 dictionaryapi 音频）
  /** 本地音频是否来自英美拼写别名（播放的是对方拼写的录音，见 offline.ts AUDIO_ALIASES）。 */
  audioAliased?: boolean;
  audioSourceUrl?: string; // 词典音频的 Wikimedia Commons 源页面，如 https://commons.wikimedia.org/w/index.php?curid=9021983（用于兜底）
  pos: string;
  definition: string;
  allPhonetics: { text?: string; audio?: string; sourceUrl?: string }[];
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

/**
 * Wiktionary 兜底查词：dictionaryapi 对部分词（如 thought、banana）会 522 且等 20 秒才失败，
 * 而 hello/world/apple 等缓存过的词是 200。522 不是拼写错误，是源站 origin 超时。
 * 此时用 Wiktionary REST（释义）+ HTML（音标 + En-*.ogg 音频）兜底，仍可听音、仍可评分
 * （无音标时评分走拼写兜底，见 main.ts）。
 */
async function fetchWordFromWiktionary(word: string): Promise<WordInfo> {
  const base = isSelfHosted() ? `${appBase()}/api/wiktionary` : 'https://en.wiktionary.org';
  // 释义（REST，JSON，快）
  let pos = '';
  let definition = '';
  try {
    const r = await fetch(`${base}/api/rest_v1/page/definition/${encodeURIComponent(word)}`);
    if (r.ok) {
      const j = await r.json();
      const en = (j?.en ?? []) as any[];
      const first = en[0];
      pos = first?.partOfSpeech ?? '';
      const defs = (first?.definitions ?? []) as any[];
      const rawDef = defs.find((d) => stripHtml(d?.definition ?? ''))?.definition ?? '';
      definition = stripHtml(rawDef);
    }
  } catch {
    // 释义失败不致命，继续拿音标/音频
  }
  // 音标 + 音频（wikitext API，JSON 小、响应头小，避免 HTML 大页面导致 nginx 502 "too big header"）
  let phonetic = '';
  let audio = '';
  try {
    const r = await fetch(`${base}/w/api.php?action=parse&page=${encodeURIComponent(word)}&prop=wikitext&format=json`);
    if (!r.ok) throw new Error(`Wiktionary 查词失败（HTTP ${r.status}）`);
    const j = await r.json();
    const wt: string = j?.parse?.wikitext?.['*'] ?? '';
    const ipaM = wt.match(/\{\{IPA\|en\|(\/[^}|]+?\/)/);
    if (ipaM) phonetic = ipaM[1];
    // {{audio|en|en-us-thought.ogg|a=US}} -> 文件名，进 Commons 解析直链
    const audioM = wt.match(/\{\{audio\|en\|([^|}]+?\.(?:ogg|mp3|wav))/i);
    const fileName = audioM?.[1]?.trim();
    if (fileName) {
      const commonsBase = isSelfHosted() ? `${appBase()}/api/commons/w/api.php` : 'https://commons.wikimedia.org/w/api.php';
      const cr = await fetch(`${commonsBase}?action=query&prop=imageinfo&iiprop=url&format=json&titles=${encodeURIComponent('File:' + fileName)}`);
      if (cr.ok) {
        const cj = await cr.json();
        const pages = cj?.query?.pages ?? {};
        const page = Object.values(pages)[0] as any;
        const rawUrl: string | undefined = page?.imageinfo?.[0]?.url;
        if (rawUrl) {
          const clean = rawUrl.split('?')[0];
          if (isSelfHosted()) {
            const mu = clean.match(/^https:\/\/upload\.wikimedia\.org\/(.+)$/);
            audio = mu ? `${appBase()}/api/wikimedia/${mu[1]}` : clean;
          } else {
            audio = clean;
          }
        }
      }
    }
  } catch {
    // wikitext 解析失败时，若已有释义仍返回（可评分兜底），否则抛错
    if (!definition && !phonetic) throw new Error(`词典与 Wiktionary 都没找到 “${word}”，请检查拼写`);
  }
  if (!definition && !phonetic && !audio) throw new Error(`词典里没找到 “${word}”，请检查拼写`);
  return {
    word,
    phonetic,
    audio,
    audioSourceUrl: '',
    pos,
    definition,
    allPhonetics: phonetic || audio ? [{ text: phonetic || undefined, audio: audio || undefined }] : [],
  };
}

export async function fetchWord(raw: string): Promise<WordInfo> {
  const word = raw.trim().toLowerCase();
  if (!word) throw new Error('请输入单词');
  if (!/^[a-z][a-z' -]*$/i.test(word)) throw new Error('请输入英文单词（仅字母、连字符、撇号）');
  // 主词典 8 秒超时：522 要等约 20 秒才返回，超时直接走 Wiktionary 兜底，不让用户干等。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${dictBase()}/api/v2/entries/en/${encodeURIComponent(word)}`, { signal: ctrl.signal });
    if (res.status === 404) {
      // 主词典 404 可能是真没词，也可能是源站问题：先试 Wiktionary，仍无才报 404
      try {
        return await fetchWordFromWiktionary(word);
      } catch {
        throw new Error(`词典里没找到 “${word}”，请检查拼写`);
      }
    }
    if (!res.ok) throw new Error(`词典请求失败（HTTP ${res.status}）`);
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
  } catch (e) {
    // 主词典失败（522/超时/断网）-> Wiktionary 兜底；兜底也失败才报主词典的错
    if (e instanceof Error && e.message.startsWith('词典里没找到')) throw e;
    try {
      return await fetchWordFromWiktionary(word);
    } catch {
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wikimedia Commons 兜底音频：
 * dictionaryapi 的 /media/*.mp3 曾出现 Cloudflare 522 / 超时（2026-10-16 实测：JSON 正常，media 全超时）。
 * 而 Commons 本身正常。词典返回的 sourceUrl 指向 Commons 文件页（如 curid=9021983 -> File:En-uk-hello.ogg），
 * 用 Commons API 解析出直链 upload.wikimedia.org/...ogg，浏览器可直接播放（ogg）。
 * 自有服务器时走同源反代 /api/wikimedia/ 与 /api/commons/（根路径部署），
 * 或 /pronunciation/api/...（旧子路径部署），避免直连被挡。
 */
export async function fetchWikimediaAudio(sourceUrl: string): Promise<string> {
  if (!sourceUrl) throw new Error('无 Wikimedia 源链接');
  const m = sourceUrl.match(/[?&]curid=(\d+)/);
  if (!m) throw new Error('无法从 sourceUrl 解析 curid');
  const pageid = m[1];
  const apiBase = isSelfHosted()
    ? `${appBase()}/api/commons/w/api.php`
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
  // upload.wikimedia.org/wikipedia/commons/4/48/En-uk-hello.ogg -> /api/wikimedia/wikipedia/commons/4/48/En-uk-hello.ogg（根路径）或 /pronunciation/api/wikimedia/...（旧子路径）
  const mu = clean.match(/^https:\/\/upload\.wikimedia\.org\/(.+)$/);
  if (mu) return `${appBase()}/api/wikimedia/${mu[1]}`;
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

/** 从词典 phonetics 列表里挑美式音标：audio 文件名含 -us 的那条的 text（如 hello-us.mp3）。 */
export function pickUsPhonetic(allPhonetics: { text?: string; audio?: string; sourceUrl?: string }[]): string {
  if (!allPhonetics) return '';
  const us = allPhonetics.find((p) => p.text && p.audio && /[-_]us\./i.test(p.audio));
  if (us?.text) return us.text;
  return '';
}

function wiktionaryBase(): string {
  return isSelfHosted() ? `${appBase()}/api/wiktionary` : 'https://en.wiktionary.org';
}

/** 美式 IPA：优先 Free Dictionary 的 -us 音标，拿不到再解析 Wiktionary wikitext 里 a=US 的 IPA。
 *  拿不到返回 ''，调用方回落英式 IPA（不报错、不空白）。 */
export async function fetchUsPhonetic(raw: string): Promise<string> {
  const word = raw.trim().toLowerCase();
  if (!word) return '';
  try {
    const info = await fetchWord(word);
    const us = pickUsPhonetic(info.allPhonetics);
    if (us) return us;
  } catch {
    // 继续试 Wiktionary
  }
  try {
    const r = await fetch(
      `${wiktionaryBase()}/w/api.php?action=parse&page=${encodeURIComponent(word)}&prop=wikitext&format=json`,
    );
    if (!r.ok) return '';
    const j = await r.json();
    const wt: string = j?.parse?.wikitext?.['*'] ?? '';
    const blocks = [...wt.matchAll(/\{\{IPA\|en\|([^}]*)\}\}/g)];
    for (const b of blocks) {
      const inner = b[1];
      if (!/a=US|\|US\b/.test(inner)) continue;
      const ipas = [...inner.matchAll(/\/[^/]+\//g)].map((m) => m[0]);
      if (ipas.length) return ipas[ipas.length - 1];
    }
  } catch {
    // 拿不到
  }
  return '';
}
