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

// ---- 宽松评分（lenient，默认开；设置里关掉即回到上面的严格分）----
//
// 产品背景：严格分是“考官”——一个音素错就按整格扣，读得能听懂也只有 50–67，
// 练起来没劲。宽松分是“教练”：用同一条对齐（ipa.ts alignPhonemes 的 ops，与
// 界面高亮同一条），按每个目标音素拿到的信用算分：
//   读对 = 1.0；读成近似音（NEAR 表）= 元音 0.6 / 辅音 0.35；读错 = 0；漏读 = 0；
//   多读一个音素扣 0.5（严格模式下相当于扣满格的一半）。
// 分数 = (Σ信用 − 插入扣分) / 目标音素数 × 100，下限 0。
// 参数标定（2026-10-22，用户真实录音，严格 -> 宽松）：
//   cat [k,ɛ,t] 67->87；cat [b,k,ɛ,t] 50->70；think [s,i,ŋ,k] 50->74；
//   think [s,ɪ,ŋ,k] 75->84；hello [h,a,l,o] 60->84；hello [a,l,a,o] 20->32（保持低）；
//   think [k,s,i,m,p]（读砸的）0->11（不虚涨）；标准录音 think/cat 仍是 100。
// 留出 50 词平均：83.1（严格）-> 86.2（宽松）。

export type ScoreMode = 'strict' | 'lenient';

/** 与 ipa.ts AlignOp 结构相同的最小形状（避免模块循环依赖）。 */
export interface AlignOpLike {
  type: 'equal' | 'sub' | 'del' | 'ins';
  expected?: string;
  actual?: string;
}

export const LENIENT_NEAR_VOWEL_CREDIT = 0.6;
export const LENIENT_NEAR_CONSONANT_CREDIT = 0.35;
export const LENIENT_INSERTION_COST = 0.5;

/**
 * 近似音对（无向，recognized ~ target 任一方向都算）。只收语音学上站得住的对：
 * 元音在共振峰空间里相邻（舌位/唇形只差一档）、辅音是 ESL 学习者最常见的
 * 系统性替代（齿间擦音被 s/f/d/z 替代、ʃ 与 s/tʃ 混、ŋ 尾鼻音弱化成 n 等）。
 * 拿不准的宁可不收——宽松的是态度，不是把错读成对。
 */
const NEAR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  // 元音
  ['æ', 'ɛ'], // cat 的 æ 读偏成 ɛ（舌位略高）
  ['ɪ', 'i'], // 短 ɪ 与长 i 只差松紧/时长，解码端两符号都出现，必须算近似
  ['ʊ', 'u'], // 同上，短 ʊ 与长 u
  ['ɒ', 'ɔ'], // 圆唇后元音的松紧差异
  ['ɑ', 'ɔ'], // 同上：目标 ɒ 在归一化后写作 ɑ，识别端出 ɔ 时是同一处混淆
  ['ə', 'ɜ'], // 中央元音邻居
  ['e', 'ɛ'], // 解码符号 e 与目标 ɛ 本就同指一个音位的不同写法
  ['ɑ', 'a'], // 开后元音与开前元音的符号/舌位差异
  ['a', 'ə'], // 非重读元音弱化方向（hello 的 /hə-/ 读成 [ha]）：弱化不到位但可懂
  // 辅音
  ['θ', 's'], // th 清音最常见的替代
  ['θ', 'f'], // th 清音的唇齿替代
  ['ð', 'd'], // th 浊音的塞音化
  ['ð', 'z'], // th 浊音的擦音替代
  ['ʃ', 's'], // ʃ 读平舌
  ['tʃ', 'ʃ'], // 破擦音弱化成擦音
  ['ŋ', 'n'], // 尾鼻音前移
  ['v', 'w'], // 唇齿擦音与唇软腭近音混淆
  ['z', 's'], // 清浊对立未分化
  ['ʒ', 'ʃ'], // 清浊对立未分化（擦音版）
  ['r', 'ɹ'], // 同一个音的符号变体
  ['ɡ', 'g'], // 手写体 ɡ 与 ASCII g 的符号变体（归一化后一般遇不到，留作兜底）
];

const NEAR_SET = new Set<string>();
for (const [a, b] of NEAR_PAIRS) {
  NEAR_SET.add(`${a}|${b}`);
  NEAR_SET.add(`${b}|${a}`);
}

/** a 与 b 是否互为近似音（对称）。 */
export function isNearPhoneme(a: string, b: string): boolean {
  return a !== b && NEAR_SET.has(`${a}|${b}`);
}

const VOWEL_TOKENS = new Set([
  'a', 'æ', 'ɛ', 'ɪ', 'i', 'ʊ', 'u', 'ɒ', 'ɔ', 'ɑ', 'ə', 'ɜ', 'e', 'o', 'ʌ',
]);

/**
 * 双元音在词元空间里是相邻两词元（见 phoneme-vocab 的 DIPH_EXPAND 与
 * normalizeTargetTokens 的切分）：[首元素, 尾元素]。
 */
const DIPHTHONG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['a', 'ɪ'], // aɪ
  ['a', 'ʊ'], // aʊ
  ['e', 'ɪ'], // eɪ
  ['o', 'ɪ'], // oɪ
  ['ɔ', 'ɪ'], // ɔɪ
  ['o', 'ʊ'], // oʊ
  ['ə', 'ʊ'], // əʊ
  ['ɑ', 'ʊ'], // ɑu
];

function isDiphthongTail(first: string, second: string): boolean {
  return DIPHTHONG_PAIRS.some(([a, b]) => a === first && b === second);
}

export interface LenientAnalysis {
  /** 宽松分（0–100 浮点，调用方按需取整）。 */
  score: number;
  /** 与 ops 等长：该 op 是否按“接近”计分（渲染用琥珀色）。 */
  near: boolean[];
}

/**
 * 在既有对齐上算宽松分。ops 必须来自 alignPhonemes(target, recognized)
 * （与界面渲染同一条对齐，保证分数与高亮永远一致）。
 * 双元音简化也算近似：目标是双元音、只读出首元素（尾元素落在 del op，
 * 且紧跟在首元素的对齐之后）时，尾元素按元音近似信用计；反过来目标是
 * 单元音、读成双元音（尾元素落在 ins op）时，只扣近似与全额的差。
 */
export function analyzeLenient(
  ops: readonly AlignOpLike[],
  targetLen: number,
): LenientAnalysis {
  const near = ops.map(() => false);
  let credit = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'equal') {
      credit += 1;
      continue;
    }
    if (op.type === 'sub') {
      if (op.expected && op.actual && isNearPhoneme(op.expected, op.actual)) {
        credit += VOWEL_TOKENS.has(op.expected)
          ? LENIENT_NEAR_VOWEL_CREDIT
          : LENIENT_NEAR_CONSONANT_CREDIT;
        near[i] = true;
      }
      continue;
    }
    if (op.type === 'del') {
      const prev = ops[i - 1];
      if (
        prev &&
        (prev.type === 'equal' || prev.type === 'sub') &&
        prev.expected &&
        op.expected &&
        isDiphthongTail(prev.expected, op.expected)
      ) {
        credit += LENIENT_NEAR_VOWEL_CREDIT;
        near[i] = true;
      }
      continue;
    }
    // ins：多读的音素
    const prev = ops[i - 1];
    if (
      prev &&
      prev.type === 'equal' &&
      prev.actual &&
      op.actual &&
      isDiphthongTail(prev.actual, op.actual)
    ) {
      credit -= 1 - LENIENT_NEAR_VOWEL_CREDIT;
      near[i] = true;
    } else {
      credit -= LENIENT_INSERTION_COST;
    }
  }
  const score =
    targetLen > 0 ? Math.max(0, Math.min(100, (credit / targetLen) * 100)) : 0;
  return { score, near };
}
