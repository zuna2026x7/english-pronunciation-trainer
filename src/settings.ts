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
