// 音素学生模型：解码 + 目标音标归一化 + 评分（纯逻辑，无 DOM / ORT 依赖，可独立测试）。
// 与桌面评估严格对齐：phonix-distill/evaluate_v5.py 的 decode（argmax -> 丢 <sil>/特殊
// 符号 -> 双元音展开 -> 折叠连续重复）+ common.py 的 normalize_gold / _split_chars /
// score_tokens。改任何一处都要同步核对 Python 版，否则端上分数与评估对不上。

import { ID2TOK, DROP_TOKENS, DIPH_EXPAND } from './phoneme-vocab';

/** logits 逐帧 argmax 解码。logits 为 [frames][numClasses] 行优先排布。 */
export function decodeLogits(
  logits: ArrayLike<number>,
  frames: number,
  numClasses: number = ID2TOK.length,
): string[] {
  const raw: string[] = [];
  for (let f = 0; f < frames; f++) {
    const base = f * numClasses;
    let best = 0;
    let bestVal = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const v = logits[base + c];
      if (v > bestVal) {
        bestVal = v;
        best = c;
      }
    }
    const tok = ID2TOK[best] ?? '<unk>';
    if (DROP_TOKENS.has(tok)) continue;
    const exp = DIPH_EXPAND[tok];
    if (exp) raw.push(...exp);
    else raw.push(tok);
  }
  return collapseDupes(raw);
}

function collapseDupes(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (!out.length || out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

// ---- 以下为 common.py 的移植（normalize_gold + _split_chars）----

const STRIP_CHARS = new Set(['ˈ', 'ˌ', 'ː', '/', ' ', '.', '-', 'ˑ']);
// 附标符号（common.py DIACRITICS）：ʰ ʷ ʲ ˤ ˠ 与组合记号 U+0329 U+032F U+0303 U+0325 U+032C U+032A U+033A
const DIACRITICS = new Set([
  'ʰ', 'ʷ', 'ʲ', 'ˤ', 'ˠ',
  '̩', '̯', '̃', '̥', '̬', '̪', '̺',
]);

/** 窄式符号 -> 宽式（common.py NARROW_MAP）。注意 ɡ 是 U+0261 手写体，与 ASCII g 不同。 */
const NARROW_MAP: Record<string, string> = {
  'ɹ': 'r', // U+0279
  'ɾ': 't', // U+027E 美式闪音 -> /t/
  g: 'ɡ', // ASCII g -> U+0261
  'ᵻ': 'ɪ', // U+1D7B
  'ɐ': 'ə', // U+0250
  'ɜ': 'ə', // U+025C（gold 里的 ɜ 经占位符还原后也会走到这里，与 Python 版一致）
};

function repAll(s: string, from: string, to: string): string {
  return s.split(from).join(to);
}

/** common.py _split_chars(collapse_dupes=False)：tʃ/dʒ 保持双字符，其余单字符切分。 */
function splitChars(sIn: string): string[] {
  let s = '';
  for (const ch of sIn) if (!DIACRITICS.has(ch)) s += ch;
  let cleaned = '';
  for (const ch of s) if (!STRIP_CHARS.has(ch)) cleaned += ch;
  cleaned = cleaned.replace(/[0-9]/g, '');
  const tokens: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const two = cleaned.slice(i, i + 2);
    let tok: string;
    if (two === 'tʃ' || two === 'dʒ') {
      tok = two;
      i += 2;
    } else {
      tok = cleaned[i];
      i += 1;
    }
    tok = NARROW_MAP[tok] ?? tok;
    if (tok.trim() === '') continue;
    tokens.push(tok);
  }
  return tokens;
}

/**
 * common.py normalize_gold：把 ECDICT 英式音标（本地词包 p 字段，如 /həˈləu/、/θiŋk/）
 * 映射到评估用的真实 IPA 词元空间（如 [h,ə,l,o,ʊ]、[θ,ɪ,ŋ,k]）。
 * 长元音先换占位符保护，避免被短元音替换（i->ɪ、u->ʊ、e->ɛ）误伤。
 */
export function normalizeTargetTokens(raw: string): string[] {
  let s = raw.trim().replace(/^\/+|\/+$/g, '');
  // ECDICT 双元音旧写法 -> 真实 IPA
  s = repAll(s, 'əu', 'oʊ');
  s = repAll(s, 'au', 'aʊ');
  s = repAll(s, 'ei', 'eɪ');
  s = repAll(s, 'ai', 'aɪ');
  s = repAll(s, 'ɔi', 'ɔɪ');
  const PH: Array<[string, string]> = [
    ['iː', '\x01'],
    ['uː', '\x02'],
    ['oː', '\x03'],
    ['aː', '\x04'],
    ['eː', '\x05'],
    ['ɑː', '\x06'],
    ['ɔː', '\x07'],
    ['ɒː', '\x08'],
    ['əː', '\x09'],
    ['ɜː', '\x0a'],
  ];
  for (const [k, v] of PH) s = repAll(s, k, v);
  // 短元音（ECDICT 写法）-> 真实 IPA
  s = repAll(s, 'i', 'ɪ');
  s = repAll(s, 'u', 'ʊ');
  s = repAll(s, 'e', 'ɛ');
  const REV: Array<[string, string]> = [
    ['\x01', 'i'],
    ['\x02', 'u'],
    ['\x03', 'o'],
    ['\x04', 'a'],
    ['\x05', 'e'],
    ['\x06', 'ɑ'],
    ['\x07', 'ɔ'],
    ['\x08', 'ɑ'],
    ['\x09', 'ə'],
    ['\x0a', 'ɜ'],
  ];
  for (const [k, v] of REV) s = repAll(s, k, v);
  // 英式短元音 ɒ -> 美式 ɑ（与评估 gold 一致）
  s = repAll(s, 'ɒ', 'ɑ');
  return splitChars(s);
}

// ---- 评分（common.py score_tokens + levenshtein）----

function levenshtein(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur: number[] = [i, ...new Array<number>(m).fill(0)];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[m];
}

/** common.py score_tokens：(1 - lev / max(len)) * 100，浮点分（调用方按需取整）。 */
export function scoreTokens(recognized: string[], target: string[]): number {
  if (recognized.length === 0 && target.length === 0) return 100;
  if (recognized.length === 0 || target.length === 0) return 0;
  const d = levenshtein(recognized, target);
  return Math.max(0, (1 - d / Math.max(target.length, recognized.length)) * 100);
}
