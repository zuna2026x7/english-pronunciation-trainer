// 热更新（OTA 补丁升级）：让 App 不用整包重下 150MB+ APK 也能拿到新版。
//
// 原理：
// - 服务器 https://speak.benext.uk/updates/manifest.json 是最新热更新清单
//   {version: "YYYYMMDD.N", files: [{path, sha256, size, role?}]}，只列新增/变更的文件。
// - App 启动时后台静默检查；有新版则逐个下载，sha256 校验通过后写进 App 私有目录
//   （Capacitor Filesystem Directory.Data 下的 ota/ 子目录），更新本地版本号。
// - 下次启动时 index.html 里的引导脚本先查本地热更新版（入口 JS/CSS 按 role 找），
//   有则加载热更新版，否则加载 APK 内置版；词表/音频由 offline.ts 同样优先读热更新版。
// - 模型 ONNX/WASM 不热更新（随 APK 走），index.html 本身也不热更新（引导脚本寄生在它上面）。
// - 任何一步失败（断网、清单 404、下载失败、校验失败）都丢弃该文件、保留旧版，不崩、不白屏。
// - 仅在 Capacitor App 内生效；网页版走正常部署，不用热更新。

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { log, setState } from './logger';

export interface OtaFile {
  path: string; // 相对 dist 根，如 assets/index-XXXX.js、data/cet4.json、data/audio/hello.ogg
  sha256: string; // 小写 hex
  size: number; // 字节
  role?: 'entry-js' | 'entry-css'; // 入口 JS/CSS 由引导脚本按 role 找；数据文件无 role，按 path 找
}

export interface OtaManifest {
  version: string; // "YYYYMMDD.N"
  files: OtaFile[];
}

const OTA_BASE = 'https://speak.benext.uk/updates';
const OTA_DIR = 'ota';
const VER_KEY = 'ept_ota_version';
const FILES_KEY = 'ept_ota_files';

export interface AppliedFile {
  uri: string; // Filesystem.getUri 返回的 file:// 绝对路径（引导脚本用它转 convertFileSrc）
  sha256: string;
  role?: 'entry-js' | 'entry-css';
}

/** 仅 Capacitor App 内启用热更新；网页版返回 false。 */
export function otaSupported(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

/** 已应用的热更新版本号（'' = 无热更新，跟随 APK 内置版）。 */
export function getAppliedVersion(): string {
  return readLocal(VER_KEY);
}

/** 已应用的热更新文件表：path -> AppliedFile（引导脚本与 offline.ts 共用）。 */
export function getAppliedFiles(): Record<string, AppliedFile> {
  try {
    const raw = readLocal(FILES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, AppliedFile>;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // ignore
  }
  return {};
}

function setAppliedFiles(files: Record<string, AppliedFile>): void {
  writeLocal(FILES_KEY, JSON.stringify(files));
}

/** APK 内置的清单版本号（index.html 构建时由 vite.config.ts 注入 __EptBundledVersion）。 */
export function getBundledVersion(): string {
  try {
    const v = (window as unknown as { __EptBundledVersion?: unknown }).__EptBundledVersion;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** "YYYYMMDD.N" 比较：返回 >0 表示 a 新于 b，<0 表示 a 旧于 b，0 表示相等。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 当前生效版本 = max(内置版, 已应用热更新版)。热更新版旧于内置版时视为失效（新 APK 已包含它）。 */
export function getCurrentVersion(): string {
  const bundled = getBundledVersion();
  const applied = getAppliedVersion();
  if (!applied) return bundled;
  if (!bundled) return applied;
  return compareVersions(applied, bundled) >= 0 ? applied : bundled;
}

/** 热更新是否生效：已应用版 >= 内置版时，热更新文件才优先于内置版。 */
export function isOtaActive(): boolean {
  const applied = getAppliedVersion();
  if (!applied) return false;
  const bundled = getBundledVersion();
  if (!bundled) return true;
  return compareVersions(applied, bundled) >= 0;
}

/** 清掉过期热更新（内置版已新于热更新版时调用，省存储；失败不抛）。 */
async function clearStaleOta(): Promise<void> {
  try {
    await Filesystem.rmdir({ directory: Directory.Data, path: OTA_DIR, recursive: true });
  } catch {
    // 目录不存在也无妨
  }
  writeLocal(VER_KEY, '');
  writeLocal(FILES_KEY, '{}');
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(new Error('base64 转换失败'));
    reader.readAsDataURL(blob);
  });
}

async function fetchManifest(): Promise<OtaManifest | null> {
  try {
    const res = await fetch(`${OTA_BASE}/manifest.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as OtaManifest;
    if (!j || typeof j.version !== 'string' || !Array.isArray(j.files)) return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * 检查服务器清单。返回 null 表示检查失败/无更新（调用方静默跳过）。
 * 返回 {manifest} 表示有新版可用（server.version > 当前生效版）。
 */
export async function checkForUpdate(): Promise<{ manifest: OtaManifest } | null> {
  if (!otaSupported()) return null;
  if (!navigator.onLine) return null;
  const manifest = await fetchManifest();
  if (!manifest) return null;
  // 内置版已新于热更新版：清掉过期热更新，下次启动用内置版
  const bundled = getBundledVersion();
  const applied = getAppliedVersion();
  if (applied && bundled && compareVersions(bundled, applied) > 0) {
    await clearStaleOta();
  }
  if (compareVersions(manifest.version, getCurrentVersion()) <= 0) return null;
  return { manifest };
}

/**
 * 下载并应用清单里的文件。单个文件失败只跳过它，不影响其他文件；
 * 全部失败时不更新版本号（保留旧版）。返回成功应用的文件数。
 * 约定：manifest.files 是该版本的完整变更集；应用成功后本地版本号 = manifest.version。
 */
export async function applyUpdate(manifest: OtaManifest): Promise<number> {
  if (!otaSupported()) return 0;
  const prev = getAppliedFiles();
  const next: Record<string, AppliedFile> = { ...prev };
  let appliedCount = 0;
  for (const f of manifest.files) {
    if (!f?.path || !f?.sha256) continue;
    // 已是同一 sha：跳过下载（断点续传 / 重复检查不浪费流量）
    if (next[f.path]?.sha256 === f.sha256) {
      appliedCount++;
      continue;
    }
    try {
      const res = await fetch(`${OTA_BASE}/${f.path}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (f.size > 0 && blob.size !== f.size) throw new Error('size 不匹配');
      const buf = await blob.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (hash !== f.sha256.toLowerCase()) throw new Error('sha256 不匹配');
      const base64 = await blobToBase64(blob);
      await Filesystem.writeFile({
        directory: Directory.Data,
        path: `${OTA_DIR}/${f.path}`,
        data: base64,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({
        directory: Directory.Data,
        path: `${OTA_DIR}/${f.path}`,
      });
      next[f.path] = { uri, sha256: f.sha256.toLowerCase(), role: f.role };
      appliedCount++;
    } catch (e) {
      // 单个文件失败：丢弃，保留旧版，继续下一个
      log('warn', `OTA 文件失败 ${f.path}: ${(e as Error)?.message || e}`);
    }
  }
  if (appliedCount > 0) {
    setAppliedFiles(next);
    writeLocal(VER_KEY, manifest.version);
    setState('ota', `已应用热更新 ${manifest.version}（${appliedCount} 个文件）`);
    log('log', `OTA applied: version=${manifest.version} files=${appliedCount}`);
  }
  return appliedCount;
}

/** 后台静默检查 + 应用（启动时调用）：失败静默，不打扰用户，不阻塞启动。 */
export async function autoCheckAndApply(): Promise<void> {
  try {
    const found = await checkForUpdate();
    if (!found) return;
    await applyUpdate(found.manifest);
  } catch {
    // 静默
  }
}

/**
 * 热更新文件的 WebView 可加载 URL（经 convertFileSrc）。
 * 未应用 / 热更新未生效时返回 ''，调用方回落内置版。
 */
export function getOtaFileUrl(path: string): string {
  if (!isOtaActive()) return '';
  const entry = getAppliedFiles()[path];
  if (!entry?.uri) return '';
  try {
    const cap = (window as unknown as { Capacitor?: { convertFileSrc?: (u: string) => string } }).Capacitor;
    if (!cap?.convertFileSrc) return '';
    return cap.convertFileSrc(entry.uri);
  } catch {
    return '';
  }
}

/** 热更新文件的文本内容（词表 cet4.json / 音频 manifest 用）。拿不到返回 null，调用方回落内置版。 */
export async function getOtaText(path: string): Promise<string | null> {
  const url = getOtaFileUrl(path);
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
