// IPA 音素切分 + 对齐 + 评分 —— 纯本地逻辑，不依赖任何 Google 包。

const TWO_CHAR = new Set([
  'iː', 'ɑː', 'ɔː', 'ɜː', 'uː',
  'eɪ', 'aɪ', 'ɔɪ', 'aʊ', 'əʊ', 'oʊ',
  'ɪə', 'eə', 'ʊə',
  'tʃ', 'dʒ',
  // 美式常见
  'ɝ', 'ɚ', 'ɾ',
]);

const ONE_CHAR = new Set([
  'i', 'ɪ', 'e', 'ɛ', 'æ', 'ɑ', 'ɒ', 'ɔ', 'ʊ', 'u', 'ʌ', 'ɜ', 'ə', 'ɐ',
  'p', 'b', 't', 'd', 'k', 'g',
  'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ',
  'm', 'n', 'ŋ', 'l', 'r', 'w', 'j', 'h',
  'ɝ', 'ɚ', 'ɾ', 'ʔ', 'x',
  // 其他元音（外来词/方言音标里可能出现，漏了会被 tokenizeIPA 丢掉，导致上下音标不一致）
  'œ', 'y', 'ø', 'ɯ', 'ɤ', 'ɨ', 'ʉ', 'ɵ', 'ɞ',
  'ː', // 极个别残留的长度符号，单独出现时忽略处理见下方
]);

const SKIP = new Set(['/', '[', ']', '(', ')', 'ˈ', 'ˌ', '.', ' ', 'ˈ'.charCodeAt(0).toString(), '\u02c8', '\u02cc']);

/** 统一音标写法：本地词包（ECDICT）用旧式 /wəːk/ 表示长元音 ɜː，在线词典是 /wɜːk/。
 *  不统一时 'əː' 会被切成 'ə' 加一个被丢掉的 'ː'，芯片就显示成 ə，和标题音标对不上。 */
export function normalizeIPA(raw: string): string {
  return raw.replace(/əː/g, 'ɜː');
}

/** 把 /həˈloʊ/ 这样的 IPA 切成音素序列，忽略重音符号与斜杠。 */
export function tokenizeIPA(raw: string): string[] {
  const s = normalizeIPA(raw).replace(/[\/\\\[\]()]/g, '').replace(/[ˈˌ]/g, '');
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      out.push(two);
      i += 2;
      continue;
    }
    const one = s[i];
    if (ONE_CHAR.has(one)) {
      // 单独的 ː 是前一音素的长度标记，已包含在 TWO_CHAR 里；单独出现则跳过
      if (one === 'ː') {
        i += 1;
        continue;
      }
      out.push(one);
      i += 1;
      continue;
    }
    if (SKIP.has(one)) {
      i += 1;
      continue;
    }
    // 未知符号：跳过，不让它污染评分
    i += 1;
  }
  return out;
}

export type AlignOp = {
  type: 'equal' | 'sub' | 'del' | 'ins';
  expected?: string;
  actual?: string;
};

/** Levenshtein 对齐，返回操作序列与编辑距离。 */
export function alignPhonemes(expected: string[], actual: string[]): { ops: AlignOp[]; distance: number } {
  const n = expected.length;
  const m = actual.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const back: ('diag' | 'up' | 'left')[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill('diag'));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = expected[i - 1] === actual[j - 1] ? 0 : 1;
      const diag = dp[i - 1][j - 1] + cost;
      const up = dp[i - 1][j] + 1; // del: 标准有、你漏了
      const left = dp[i][j - 1] + 1; // ins: 你多读了
      let best = diag;
      let dir: 'diag' | 'up' | 'left' = 'diag';
      if (up < best) { best = up; dir = 'up'; }
      if (left < best) { best = left; dir = 'left'; }
      dp[i][j] = best;
      back[i][j] = dir;
    }
  }
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && back[i][j] === 'diag') {
      if (expected[i - 1] === actual[j - 1]) {
        ops.push({ type: 'equal', expected: expected[i - 1], actual: actual[j - 1] });
      } else {
        ops.push({ type: 'sub', expected: expected[i - 1], actual: actual[j - 1] });
      }
      i--; j--;
    } else if (i > 0 && (j === 0 || back[i][j] === 'up')) {
      ops.push({ type: 'del', expected: expected[i - 1] });
      i--;
    } else {
      ops.push({ type: 'ins', actual: actual[j - 1] });
      j--;
    }
  }
  ops.reverse();
  return { ops, distance: dp[n][m] };
}

export function scoreFromAlignment(expectedLen: number, actualLen: number, distance: number, wordMatch: boolean): number {
  const denom = Math.max(expectedLen, actualLen, 1);
  let score = Math.round(100 * (1 - distance / denom));
  if (wordMatch) score = Math.min(100, Math.max(score, 90) + 0);
  // 整词一致时至少 90，避免音标切分抖动把正确发音打低
  if (wordMatch && score < 90) score = 90;
  return Math.max(0, Math.min(100, score));
}

export function gradeForScore(score: number): string {
  if (score >= 90) return '优秀 · 非常接近标准读音';
  if (score >= 75) return '良好 · 个别音素需微调';
  if (score >= 60) return '及格 · 有明显可改进的音';
  return '需加强 · 先慢速跟读，再逐个音纠正';
}

export function describeOp(op: AlignOp): string | null {
  if (op.type === 'sub') return `把 /${op.expected}/ 读成了 /${op.actual}/`;
  if (op.type === 'del') return `漏读了 /${op.expected}/`;
  if (op.type === 'ins') return `多读了 /${op.actual}/`;
  return null;
}
