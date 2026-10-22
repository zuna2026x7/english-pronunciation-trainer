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

// 音素学生模型打分开关（feat/phoneme-onnx-scorer 测试版）：本版默认开。
// 关掉且服务器打分也关/不可用时，打分会直接报“没有可用的打分通道”。
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

// 服务器打分开关（feat/phoneme-onnx-scorer 测试版）：默认开。有网且开时优先把录音
// 发到自建打分服务（fp32 学生模型）；失败/关掉才回落本地音素模型。关掉 = 显式本地模式
// （此时音素模型是主通道，首次打分允许触发模型下载）。
const SERVER_SCORER_KEY = 'ept_server_scorer';

export function getServerScorer(): boolean {
  try {
    return localStorage.getItem(SERVER_SCORER_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setServerScorer(on: boolean): void {
  try {
    localStorage.setItem(SERVER_SCORER_KEY, on ? '1' : '0');
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
