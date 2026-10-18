// 界面改版（ui-redesign）：SVG 图标 + 布局重排。
//
// 重要：旧 APK 的热更新只换 JS/CSS，不换 index.html。所以新布局不能只写在 HTML 里——
// ensureLayout() 在启动时按 id 把现有节点搬进新结构（顶栏 / 音标行 / 底栏 / 分数环），
// 新版 HTML 已经是新结构时它什么也不做（幂等）。任何一步找不到元素都跳过，绝不报错白屏。

const SVG_ATTR = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"';

export const ICONS = {
  search: `<svg ${SVG_ATTR} width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  settings: `<svg ${SVG_ATTR} width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  speaker: `<svg ${SVG_ATTR} width="24" height="24" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  chevronDown: `<svg ${SVG_ATTR} width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
  chevronUp: `<svg ${SVG_ATTR} width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>`,
  play: `<svg ${SVG_ATTR} width="18" height="18" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>`,
  stop: `<svg ${SVG_ATTR} width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  mic: `<svg ${SVG_ATTR} width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`,
  log: `<svg ${SVG_ATTR} width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>`,
  check: `<svg ${SVG_ATTR} width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>`,
};

const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;

const byId = (id: string) => document.getElementById(id);

function el(tag: string, cls: string, id?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (id) e.id = id;
  return e;
}

/** 启动时调用一次：把旧 HTML 结构整理成新布局。新 HTML 下为空操作。 */
export function ensureLayout(): void {
  try {
    const wrap = document.querySelector('main.wrap') as HTMLElement | null;
    const hero = document.querySelector('header.hero') as HTMLElement | null;
    const input = byId('wordInput');
    const lookupBtn = byId('lookupBtn');
    const settingsBtn = byId('settingsBtn');

    // 1) 顶栏：搜索框 + 右上设置
    if (hero && input && !input.closest('.topbar-search')) {
      hero.classList.add('topbar');
      hero.querySelector('h1')?.remove();
      const box = el('label', 'topbar-search');
      box.innerHTML = ICONS.search;
      box.appendChild(input);
      if (lookupBtn) box.appendChild(lookupBtn);
      hero.insertBefore(box, hero.firstChild);
      const status = byId('lookupStatus');
      if (status) hero.insertAdjacentElement('afterend', status);
      document.querySelector('section.search-card')?.remove();
    }
    // 1b) 标题栏：标题 + 右上设置，单独一行，避开系统状态栏；搜索框放在它下面
    if (hero && settingsBtn && !hero.querySelector('.appbar-row')) {
      const row = el('div', 'appbar-row');
      const title = el('h1', 'app-title');
      title.innerHTML = ICONS.mic + '<span>Phonix</span>';
      row.appendChild(title);
      row.appendChild(settingsBtn);
      hero.insertBefore(row, hero.firstChild);
    }
    document.title = 'Phonix';
    // 让 WebView 报告刘海/状态栏安全区（env(safe-area-inset-top)）
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp && !/viewport-fit/.test(vp.getAttribute('content') || '')) {
      vp.setAttribute('content', (vp.getAttribute('content') || '') + ', viewport-fit=cover');
    }
    if (lookupBtn) lookupBtn.classList.add('visually-hidden');
    if (settingsBtn) {
      settingsBtn.classList.add('icon-square');
      settingsBtn.innerHTML = ICONS.settings;
    }

    // 2) 音标行：IPA + 喇叭
    const ipa = byId('ipaText');
    const play = byId('playNormal');
    if (ipa && play && !ipa.closest('.ipa-row')) {
      const row = el('div', 'ipa-row');
      ipa.parentElement?.insertBefore(row, ipa);
      const accent = el('span', 'ipa-accent', 'ipaAccent');
      const left = el('div', 'ipa-left');
      left.appendChild(accent);
      left.appendChild(ipa);
      row.appendChild(left);
      row.appendChild(play);
      document.querySelector('.play-row')?.remove();
    }
    if (play) {
      play.className = 'speaker-btn';
      play.innerHTML = ICONS.speaker;
    }

    // 3) 释义：蓝色胶囊，仍然可折叠
    const defToggle = byId('defToggleBtn');
    if (defToggle) defToggle.className = 'def-toggle pill';

    // 4) 分数环：SVG 圆环，数字在环内，不再溢出
    const circle = document.querySelector('.score-circle') as HTMLElement | null;
    if (circle && !circle.querySelector('svg')) {
      circle.className = 'score-ring';
      circle.innerHTML =
        `<svg viewBox="0 0 96 96" width="96" height="96" aria-hidden="true">` +
        `<circle class="ring-track" cx="48" cy="48" r="${RING_R}" fill="none" stroke-width="8"/>` +
        `<circle id="scoreArc" class="ring-arc" cx="48" cy="48" r="${RING_R}" fill="none" stroke-width="8" stroke-linecap="round" ` +
        `stroke-dasharray="0 ${RING_C.toFixed(1)}" transform="rotate(-90 48 48)"/></svg>` +
        `<div class="ring-num"><b id="scoreNum">—</b><span>/ 100</span></div>`;
    }
    // 评级拆成 主评级 + 副说明
    const grade = byId('gradeText');
    if (grade && !byId('gradeSub')) {
      grade.className = 'grade';
      const sub = el('p', 'grade-sub', 'gradeSub');
      grade.insertAdjacentElement('afterend', sub);
      const recog = byId('recognizedText')?.parentElement;
      if (recog) recog.className = 'recog';
    }

    // 5) 底栏：回放 + 大号“按住录音”
    const rec = byId('recBtn');
    const mine = byId('playMineBtn');
    if (rec && !rec.closest('.bottombar')) {
      const bar = el('div', 'bottombar', 'bottomBar');
      if (mine) bar.appendChild(mine);
      bar.appendChild(rec);
      document.body.appendChild(bar);
      document.querySelector('.rec-row')?.remove();
    }
    if (rec) {
      rec.className = 'rec-btn hold-btn';
      rec.innerHTML = `${ICONS.mic}<span>按住录音</span>`;
      rec.setAttribute('aria-label', '按住录音');
    }
    if (mine) {
      mine.className = 'replay-btn';
      setReplayIcon(false);
    }

    // 6) 设置浮层里的日志按钮
    const logBtn = byId('settingsLogBtn');
    if (logBtn) logBtn.innerHTML = `${ICONS.log}<span>日志</span>`;

    // 页脚版本号挪进设置（设置里已有版本），主页不再显示
    document.querySelector('.app-footer')?.remove();
    if (wrap) wrap.classList.add('has-bottombar');
  } catch {
    // 布局整理失败不影响功能
  }
}

/** 释义弹窗：居中显示，点遮罩关闭。元素动态创建，OTA 安全（旧 HTML 没有它们）。 */
export function showDefModal(text: string): void {
  let backdrop = byId('defBackdrop');
  if (!backdrop) {
    backdrop = el('div', 'def-backdrop', 'defBackdrop');
    backdrop.addEventListener('click', hideDefModal);
    document.body.appendChild(backdrop);
  }
  let modal = byId('defModal');
  if (!modal) {
    modal = el('div', 'def-modal', 'defModal');
    modal.appendChild(el('p', 'def-modal-text', 'defModalText'));
    document.body.appendChild(modal);
  }
  const textEl = byId('defModalText');
  if (textEl) textEl.textContent = text;
  if (backdrop) backdrop.hidden = false;
  if (modal) modal.hidden = false;
}

export function hideDefModal(): void {
  const b = byId('defBackdrop');
  if (b) b.hidden = true;
  const m = byId('defModal');
  if (m) m.hidden = true;
}

export function setReplayIcon(playing: boolean): void {
  const b = byId('playMineBtn');
  if (b) b.innerHTML = `${playing ? ICONS.stop : ICONS.play}<span>回放</span>`;
}

export function setAccentLabel(type: 'uk' | 'us'): void {
  const a = byId('ipaAccent');
  if (a) a.textContent = type === 'us' ? '美' : '英';
}

/** 美式录音标注：仅当当前词的音频来自英美拼写别名时显示（音标行下方小字）。
 *  OTA 只换 JS/CSS 不换 HTML，元素动态创建，保证旧 HTML 下也能用。
 *  注意：它标的是录音口音，不是音标口音（音标仍由左上角 英/美 标）。 */
export function setAudioAccentLabel(kind: 'us' | null): void {
  let a = byId('audioAccent');
  if (!a) {
    const row = document.querySelector('.ipa-row');
    if (!row) return;
    a = el('div', 'audio-accent', 'audioAccent');
    row.insertAdjacentElement('afterend', a);
  }
  a.textContent = kind === 'us' ? '美式录音' : '';
  a.hidden = kind !== 'us';
}

/** 分数环：弧长与颜色随分数变化。 */
export function setScoreRing(score: number): void {
  const num = byId('scoreNum');
  if (num) num.textContent = String(score);
  const level = score >= 90 ? 'great' : score >= 75 ? 'good' : score >= 60 ? 'ok' : 'low';
  const ring = document.querySelector('.score-ring') as HTMLElement | null;
  if (ring) ring.dataset.level = level;
  const grade = byId('gradeText');
  if (grade) grade.dataset.level = level;
  const arc = byId('scoreArc');
  if (arc) {
    const len = (Math.max(0, Math.min(100, score)) / 100) * RING_C;
    arc.setAttribute('stroke-dasharray', `${len.toFixed(1)} ${RING_C.toFixed(1)}`);
  }
}

/** “优秀 · 非常接近标准读音” -> 主评级 + 副说明 */
export function setGrade(text: string): void {
  const [main, sub] = text.split(' · ');
  const g = byId('gradeText');
  if (g) g.textContent = main || text;
  const s = byId('gradeSub');
  if (s) s.textContent = sub || '';
}
