// 诊断日志：捕获 console + 未捕获错误 + 关键状态，缓存在内存；点“📋 日志”上传到 /api/log。
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

export async function uploadLogs(): Promise<boolean> {
  try {
    const res = await fetch('/api/log/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'pronunciation',
        version: 'offline-4500',
        ts: Date.now(),
        deviceInfo: deviceInfo(),
        logs: entries,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
