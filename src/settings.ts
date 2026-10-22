// 设置：音标类型（英式 / 美式），存 localStorage，默认英式（保持现有行为）。

export type IpaType = 'uk' | 'us';

const IPA_TYPE_KEY = 'ept_ipa_type';

export function getIpaType(): IpaType {
  try {
    return localStorage.getItem(IPA_TYPE_KEY) === 'us' ? 'us' : 'uk';
  } catch {
    return 'uk';
  }
}

export function setIpaType(t: IpaType): void {
  try {
    localStorage.setItem(IPA_TYPE_KEY, t);
  } catch {
    // ignore
  }
}

// 音素学生模型打分开关（feat/phoneme-onnx-scorer 测试版）：本版默认开，关掉只用 Whisper 打分。
const PHONEME_SCORER_KEY = 'ept_phoneme_scorer';

export function getPhonemeScorer(): boolean {
  try {
    return localStorage.getItem(PHONEME_SCORER_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setPhonemeScorer(on: boolean): void {
  try {
    localStorage.setItem(PHONEME_SCORER_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

// 释义展开状态：记住用户上次是展开还是收起，默认收起。
const DEF_OPEN_KEY = 'ept_def_open';

export function getDefOpen(): boolean {
  try {
    return localStorage.getItem(DEF_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDefOpen(open: boolean): void {
  try {
    localStorage.setItem(DEF_OPEN_KEY, open ? '1' : '0');
  } catch {
    // ignore
  }
}
