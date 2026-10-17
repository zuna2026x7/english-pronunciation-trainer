// 诊断日志：捕获 console + 未捕获错误 + 关键状态，缓存在内存；点“📋 日志”上传到 /api/log（Web）或 https://speak.benext.uk/api/log/（Capacitor）。
// 不记密码/token 等敏感信息：上报前按 key 脱敏，单条截断。

export interface LogEntry {
  t: number;
  level: string;
  msg: string;
}

const MAX_ENTRIES = 300;
const entries: LogEntry[] = [];
const states: Record<string, string> = {};
let hooked = false;

const SENSITIVE = /token|password|passwd|secret|authorization|cookie|apikey|api[_-]?key/i;

function scrub(text: string): string {
  if (SENSITIVE.test(text)) return '[redacted]';
  return text.slice(0, 500);
}

export function log(level: string, msg: string): void {
  try {
    entries.push({ t: Date.now(), level, msg: scrub(msg) });
    if (entries.length > MAX_ENTRIES) entries.shift();
  } catch {
    // 日志本身绝不抛错
  }
}

export function setState(key: string, value: string): void {
  try {
    states[key] = scrub(value).slice(0, 200);
  } catch {
    // ignore
  }
}

export function initLogger(): void {
  if (hooked) return;
  hooked = true;
  try {
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    console.log = (...a: unknown[]) => {
      try {
        log('log', a.map(String).join(' '));
      } catch {
        // ignore
      }
      origLog(...a);
    };
    console.warn = (...a: unknown[]) => {
      try {
        log('warn', a.map(String).join(' '));
      } catch {
        // ignore
      }
      origWarn(...a);
    };
    console.error = (...a: unknown[]) => {
      try {
        log('error', a.map(String).join(' '));
      } catch {
        // ignore
      }
      origError(...a);
    };
    window.addEventListener('error', (e) => {
      log('error', `uncaught: ${e.message || ''}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = (e as PromiseRejectionEvent).reason;
      log('error', `rejection: ${String(r?.message || r || '')}`);
    });
  } catch {
    // ignore
  }
}

function deviceInfo(): Record<string, string> {
  try {
    return {
      ua: navigator.userAgent.slice(0, 300),
      platform: (navigator as Navigator & { platform?: string }).platform || '',
      language: navigator.language || '',
      online: String(navigator.onLine),
      url: location.href.slice(0, 200),
      states: JSON.stringify(states).slice(0, 2000),
    };
  } catch {
    return {};
  }
}

export async function uploadLogs(audioBlob?: Blob | null): Promise<boolean> {
  // Capacitor App 跑在 https://localhost：相对路径 /api/log/ 会发到 https://localhost/api/log/，
  // 根本到不了 speak.benext.uk。App 内用绝对地址，Web 端保持相对路径。
  const isCapacitor =
    typeof window !== 'undefined' &&
    (!!(window as unknown as { Capacitor?: unknown }).Capacitor ||
      (window.location.hostname === 'localhost' &&
        window.location.protocol === 'https:' &&
        !window.location.port));
  const url = isCapacitor ? 'https://speak.benext.uk/api/log/' : '/api/log/';
  try {
    // 附带最新一次录音（用户点“发送日志”时才传，供诊断用；不自动上传）。
    let audio: { base64: string; mimeType: string } | undefined;
    if (audioBlob && audioBlob.size > 0) {
      const buf = await audioBlob.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      audio = { base64: btoa(bin), mimeType: audioBlob.type || 'audio/webm' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'pronunciation',
        version: 'offline-4500',
        ts: Date.now(),
        deviceInfo: deviceInfo(),
        logs: entries,
        ...(audio ? { audio } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
