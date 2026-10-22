import { fetchWord, fetchWikimediaAudio, pickUsPhonetic, fetchUsPhonetic, type WordInfo } from './dictionary';
import { playAtRate, SPEEDS } from './audio';
import { Recorder, blobToPCM16k, pcmPeak } from './recorder';
import { scoreWithStudent, warmupStudentModel, probeStudentReady } from './phoneme-scorer';
import { scoreWithServer } from './server-scorer';
import { normalizeTargetTokens, scoreTokens } from './phoneme-decode';
import { alignPhonemes, gradeForScore, describeOp } from './ipa';
import { lookupLocal, speakTTS, reportMissingWord } from './offline';
import { initLogger, log, setState, uploadLogs } from './logger';
import { getIpaType, setIpaType, getPhonemeScorer, setPhonemeScorer, getServerScorer, setServerScorer } from './settings';
import { autoCheckAndApply, checkForUpdate, applyUpdate, getCurrentVersion, otaSupported } from './updater';
import { ensureLayout, showDefModal, setReplayIcon, setAccentLabel, setAudioAccentLabel, setScoreRing, setGrade } from './ui';
import { normalizeIPA } from './ipa';

initLogger();

// 热更新：App 打开后后台静默检查（仅 Capacitor App，网页版跳过）。
// 有新版则下载并应用，下次启动生效；失败静默，不阻塞启动、不打扰用户。
if (otaSupported() && navigator.onLine) {
  void autoCheckAndApply();
}

// Service Worker：缓存应用壳 + 词表 + 模型文件，首次联网加载后可离线用。
// 注册失败（如 file:// 或旧浏览器）不影响正常使用。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// 新布局：必须在下面按 id 取元素之前跑（它会替换分数环里的 #scoreNum 等节点）
ensureLayout();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const wordInput = $('wordInput') as HTMLInputElement;
const lookupBtn = $('lookupBtn');
const lookupStatus = $('lookupStatus');
const wordCard = $('wordCard');
const wordTitle = $('wordTitle');
const posBadge = $('posBadge');
const ipaText = $('ipaText');
const defText = $('defText');
const defToggleBtn = $('defToggleBtn');
const refAudio = $('refAudio') as HTMLAudioElement;
const playNormal = $('playNormal');
const practiceCard = $('practiceCard');
const recBtn = $('recBtn');
const playMineBtn = $('playMineBtn');
const settingsBtn = $('settingsBtn');
const settingsCard = $('settingsCard');
const ipaUkBtn = $('ipaUkBtn');
const ipaUsBtn = $('ipaUsBtn');
const settingsLogBtn = $('settingsLogBtn');
const settingsUpdateBtn = $('settingsUpdateBtn');
const settingsVersion = $('settingsVersion');
const settingsStatus = $('settingsStatus');
const recStatus = $('recStatus');
const modelStatus = $('modelStatus');
const resultEl = $('result');
const scoreNum = $('scoreNum');
const gradeText = $('gradeText');
const recognizedText = $('recognizedText');
const expectedPhonemes = $('expectedPhonemes');
const userPhonemes = $('userPhonemes');
const errorList = $('errorList');
const fallbackNote = $('fallbackNote');

let current: WordInfo | null = null;
let ukPhonetic = ''; // 本次查词的英式音标（本地词表 p 字段 / 在线词典 phonetic），切回英式时用
let recorder: Recorder | null = null;
let myBlob: Blob | null = null;
let myPcm: Float32Array | null = null;
let playbackSource: AudioBufferSourceNode | null = null;
let triedWikimediaFallback = false;

// 连点循环变速：2 秒内连点 -> 下一档（1.0 -> 0.65 -> 0.40 -> 1.0）；间隔超过 2 秒 -> 回到 1.0
let playSpeedIdx = 0;
let lastPlayTapAt = 0;
const CONSECUTIVE_MS = 2000;

// 音频兜底：主音频失败时自动切到另一个源再播一次，只兜底一次，避免循环。
// 现在 lookup 优先用 Wikimedia，失败则切回词典音频；若 lookup 用的是词典音频，失败则切 Wikimedia。
refAudio.addEventListener('error', async () => {
  if (!current || triedWikimediaFallback) return;
  triedWikimediaFallback = true;
  const isWm = refAudio.src.includes('wikimedia') || refAudio.src.includes('upload.wikimedia.org');
  try {
    if (isWm && current.audio) {
      lookupStatus.textContent = '切换音频源';
      refAudio.src = current.audio;
      lookupStatus.textContent = '请再点播放。';
    } else if (!isWm && current.audioSourceUrl) {
      lookupStatus.textContent = '切换音频源';
      const fb = await fetchWikimediaAudio(current.audioSourceUrl);
      refAudio.src = fb;
      lookupStatus.textContent = '请再点播放。';
    }
  } catch (e) {
    lookupStatus.textContent = '音频失败，稍后重试。';
  }
});

// 不保存记录：用户不要记录功能。启动时清掉旧版本存过的记录。
try { localStorage.removeItem('ept_history_v1'); } catch { /* ignore */ }

function setPlayEnabled(enabled: boolean) {
  (playNormal as HTMLButtonElement).disabled = !enabled;
}

/** 美式模式：优先用本次查词已带回的 -us 音标，否则后台在线取；取不到保持英式。 */
async function applyUsPhoneticIfNeeded(word: string): Promise<void> {
  if (getIpaType() !== 'us' || !navigator.onLine) return;
  const fromList =
    current && current.word.toLowerCase() === word.toLowerCase()
      ? pickUsPhonetic(current.allPhonetics || [])
      : '';
  if (fromList) {
    if (current?.word.toLowerCase() === word.toLowerCase()) {
      current.phonetic = fromList;
      ipaText.textContent = fromList;
      setAccentLabel('us');
    }
    return;
  }
  try {
    const us = await fetchUsPhonetic(word);
    if (us && current?.word.toLowerCase() === word.toLowerCase()) {
      current.phonetic = us;
      ipaText.textContent = us;
      setAccentLabel('us');
    }
  } catch {
    // 保持英式
  }
}

async function lookup(word: string) {
  lookupStatus.textContent = '';
  lookupBtn.setAttribute('disabled', 'true');
  try {
    // 离线优先：先查本地词包（离线可用）；本地没有再走在线词典/Wiktionary 兜底。
    const local = await lookupLocal(word);
    const fromLocal = !!local;
    let info: WordInfo;
    if (local) {
      info = local;
    } else {
      try {
        info = await fetchWord(word);
      } catch (e) {
        // 本地没有、在线也查不到：上报缺词（供下次打包时核查补词），再按原逻辑报错。
        void reportMissingWord(word, false);
        throw e;
      }
      // 本地没有、在线查到了：也是缺词（真实存在的词），上报供下次打包补进词包。
      void reportMissingWord(word, true);
    }
    log('log', `lookup done: ${word} fromLocal=${fromLocal}`);
    current = info;
    // 别名音频：播放的是对方拼写的录音（美式），音标行下方标注，避免与英式音标混淆
    setAudioAccentLabel(info.audioAliased ? 'us' : null);
    wordTitle.textContent = info.word;
    posBadge.textContent = info.pos || '';
    posBadge.style.display = info.pos ? '' : 'none';
    // 本地词包是旧式写法（/wəːk/），统一成 /wɜːk/，标题音标和“标准”芯片用同一串
    info.phonetic = normalizeIPA(info.phonetic || '');
    ukPhonetic = info.phonetic;
    ipaText.textContent = info.phonetic || '—';
    setAccentLabel('uk');
    // 美式模式：后台升级美式音标（取不到保持英式，不动其他显示）
    void applyUsPhoneticIfNeeded(info.word);
    defText.textContent = info.definition ? `${info.pos ? info.pos + ' · ' : ''}${info.definition}` : '';
    // 释义走居中弹窗（点 释义 打开，点弹窗外面关闭），行内不再展开
    defText.hidden = true;
    playSpeedIdx = 0;
    lastPlayTapAt = 0;
    defToggleBtn.hidden = !info.definition;
    wordCard.hidden = false;
    practiceCard.hidden = false;
    resultEl.hidden = true;
    recStatus.textContent = '';
    myBlob = null;
    myPcm = null;
    if (playbackSource) { try { playbackSource.stop(); } catch {} playbackSource = null; setReplayIcon(false); }
    playMineBtn.hidden = true;
    refAudio.removeAttribute('src');
    triedWikimediaFallback = false;
    // 播放按钮始终可用：有真人音频播真人音频，没有则 TTS 兜底。
    setPlayEnabled(true);
    if (info.audio || info.audioSourceUrl) {
      await loadRealAudio(info);
    }
    // 本地词无真人音频：有网时后台升级一次真人音频（只换音频，不动显示的音标/释义）。
    // 离线/失败时保持 TTS，播放不受影响。本地已有真人音频时不覆盖（本地的就是真人录音，且离线可用）。
    if (fromLocal && !info.audio && navigator.onLine) {
      void (async () => {
        try {
          const online = await fetchWord(word);
          if (
            current?.word.toLowerCase() === online.word.toLowerCase() &&
            (online.audio || online.audioSourceUrl)
          ) {
            current = { ...current, audio: online.audio, audioSourceUrl: online.audioSourceUrl, allPhonetics: online.allPhonetics };
            await loadRealAudio(current, true);
          }
        } catch {
          // 保持 TTS
        }
      })();
    }
    // 音素学生模型预热：只在已下载缓存时加载会话，绝不后台偷跑 122MB 下载。
    // 结构性防护：预热在查词主流程里同步调用，这里再包一层 try——新打分通道
    // 任何同步异常都不许冒泡打断查词（其内部本就有 try/catch，这是接缝处的双保险）。
    if (getPhonemeScorer()) {
      try {
        warmupStudentModel();
      } catch {
        // 预热失败静默：打分时还有 tryStudentScore 的回落
      }
    }
    wordInput.value = info.word;
  } catch (e) {
    lookupStatus.textContent = '没找到，检查拼写。';
  } finally {
    lookupBtn.removeAttribute('disabled');
  }
}

/** 真人音频：Wikimedia 优先（词典 /media/*.mp3 曾 522 超时），失败则回落词典音频。
 *  silentNoAudio=true 时无音频不写状态文案（用于本地词后台升级音频时不打扰）。 */
async function loadRealAudio(info: WordInfo, silentNoAudio = false): Promise<void> {
  // 音频优先走 Wikimedia：词典 /media/*.mp3 目前 522 且要等约 20 秒才失败，
  // 用户点播放会长时间没声。Wikimedia Commons 实测快且可用，有 sourceUrl 时优先用它，
  // 失败则回落到词典音频（error 监听会再兜底一次）。
  let audioSrc = info.audio;
  let wmUsed = false;
  if (info.audioSourceUrl) {
    try {
      const wm = await Promise.race([
        fetchWikimediaAudio(info.audioSourceUrl),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      audioSrc = wm;
      wmUsed = true;
    } catch {
      // 保持词典音频为主，播放失败时 error 监听会再试 Wikimedia
    }
  }
  triedWikimediaFallback = wmUsed;
  if (audioSrc) {
    refAudio.src = audioSrc;
    lookupStatus.textContent = '';
  } else if (!silentNoAudio) {
    refAudio.removeAttribute('src');
    lookupStatus.textContent = '';
  }
}

lookupBtn.addEventListener('click', () => lookup(wordInput.value));
wordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    wordInput.blur(); // 查词后收起输入法，避免它挡住/误弹
    lookup(wordInput.value);
  }
});
defToggleBtn.addEventListener('click', () => {
  showDefModal(defText.textContent || '');
});

async function playWithFallback(rate: number) {
  // 无真人音频（本地词 / 离线）-> TTS 播放；有真人音频 -> 现有逻辑。
  if (!refAudio.src) {
    if (!current) throw new Error('无单词');
    await speakTTS(current.word, rate);
    return;
  }
  try {
    await playAtRate(refAudio, rate);
  } catch (e) {
    // 本地音频文件缺失/损坏 -> 回落 TTS（用户仍能听到发音，不报错刷屏）
    if (current && refAudio.src.includes('data/audio/')) {
      refAudio.removeAttribute('src');
      await speakTTS(current.word, rate);
      return;
    }
    // 主音频播放失败时，切到另一个源再试一次（若 error 监听未触发）
    if (current && !triedWikimediaFallback) {
      triedWikimediaFallback = true;
      try {
        const isWm = refAudio.src.includes('wikimedia') || refAudio.src.includes('upload.wikimedia.org');
        if (isWm && current.audio) {
          refAudio.src = current.audio;
        } else if (!isWm && current.audioSourceUrl) {
          refAudio.src = await fetchWikimediaAudio(current.audioSourceUrl);
        } else {
          throw e;
        }
        await playAtRate(refAudio, rate);
        lookupStatus.textContent = '';
        return;
      } catch {
        // 落到下方统一报错
      }
    }
    throw e;
  }
}

playNormal.addEventListener('click', async () => {
  const now = Date.now();
  if (now - lastPlayTapAt > CONSECUTIVE_MS) {
    playSpeedIdx = 0;
  } else {
    playSpeedIdx = (playSpeedIdx + 1) % SPEEDS.length;
  }
  lastPlayTapAt = now;
  const rate = SPEEDS[playSpeedIdx];
  log('log', `play: ${current?.word || ''} rate=${rate}`);
  try { await playWithFallback(rate); } catch (e) { log('error', `play failed: ${(e as Error)?.message || e} src=${refAudio.src || '(tts)'}`); lookupStatus.textContent = '播放失败，稍后重试。'; }
});

// 按住录音：手指按住开始，松开停止并自动打分（像微信按住说话）。
// 用 Pointer Events 同时覆盖鼠标与触摸；长按不触发右键菜单/选中。
let isHolding = false;
let startPromise: Promise<void> | null = null;

async function startHoldRecord(): Promise<boolean> {
  if (!current) {
    recStatus.textContent = '先查一个词。';
    return false;
  }
  if (recorder?.isRecording) return true;
  recorder = new Recorder();
  startPromise = recorder.start();
  try {
    await startPromise;
    recBtn.classList.add('recording');
    const recLabel = recBtn.querySelector('span');
    if (recLabel) recLabel.textContent = '松开结束';
    recStatus.textContent = '录音中';
    // 不隐藏结果区：hidden 会让布局回流、页面跳动（“位置飘走”）。旧结果留着，新分数出来再覆盖。
    return true;
  } catch (e) {
    log('error', `record start failed: ${(e as Error)?.name || e}`);
    recStatus.textContent = '无法录音，请允许麦克风权限。';
    return false;
  } finally {
    startPromise = null;
  }
}

async function stopHoldRecordAndScore(): Promise<void> {
  if (!recorder) return;
  // 若松开时 start 还在等麦克风权限，先等它完成再停，避免 stop 时 rec 为空
  if (startPromise) {
    try { await startPromise; } catch { return; }
  }
  if (!recorder.isRecording) return;
  recBtn.classList.remove('recording');
  resetRecLabel();
  try {
    const blob = await recorder.stop();
    myBlob = blob;
    myPcm = null;
    playMineBtn.hidden = false;
    recStatus.textContent = '评分中';
    await runScore();
  } catch (e) {
    recStatus.textContent = '停止失败，重试。';
  } finally {
    recBtn.classList.remove('recording');
    resetRecLabel();
  }
}

function resetRecLabel(): void {
  const recLabel = recBtn.querySelector('span');
  if (recLabel) recLabel.textContent = '按住录音';
}

recBtn.addEventListener('pointerdown', (e) => {
  // preventDefault 会阻止焦点从输入框移走：刚输完单词时输入框仍是焦点，
  // Android 上按下录音（界面变红/重排）时输入法会被重新弹出。先主动收起键盘。
  wordInput.blur();
  e.preventDefault();
  if (isHolding) return;
  isHolding = true;
  void startHoldRecord();
});
const endHold = (e: Event) => {
  e.preventDefault();
  if (!isHolding) return;
  isHolding = false;
  void stopHoldRecordAndScore();
};
recBtn.addEventListener('pointerup', endHold);
// 注意：不要用 pointerleave 结束录音。手指按住时稍微滑出按钮就会触发 pointerleave，
// 录音被提前截断成很短的一段，Whisper 对过短音频经常返回空，看起来就是“老是识别不出来”。
// 只用 pointerup / pointercancel 结束；触摸下 pointerup 即使手指滑出也会触发。
recBtn.addEventListener('pointercancel', endHold);
recBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// 设置：⚙️ 开关设置卡片；音标类型切换后立即生效；日志按钮在设置页面里。
function renderIpaButtons(): void {
  const t = getIpaType();
  ipaUkBtn.classList.toggle('selected', t === 'uk');
  ipaUsBtn.classList.toggle('selected', t === 'us');
}

// 音素模型打分开关行：动态创建，不写进 index.html（理由同下方设置遮罩：
// index.html 不热更新，JS 动态生成的行让 OTA 补丁自包含）。练习页不加任何元素。
function ensurePhonemeScorerRow(): void {
  if (document.getElementById('phonemeScorerRow')) return;
  const row = document.createElement('div');
  row.className = 'settings-row';
  row.id = 'phonemeScorerRow';
  const label = document.createElement('span');
  label.className = 'settings-label';
  label.textContent = '音素模型打分（测试）';
  const seg = document.createElement('div');
  seg.className = 'seg';
  const onBtn = document.createElement('button');
  onBtn.id = 'phonemeOnBtn';
  onBtn.className = 'btn seg-btn';
  onBtn.textContent = '开';
  const offBtn = document.createElement('button');
  offBtn.id = 'phonemeOffBtn';
  offBtn.className = 'btn seg-btn';
  offBtn.textContent = '关';
  onBtn.addEventListener('click', () => {
    setPhonemeScorer(true);
    renderPhonemeScorerButtons();
  });
  offBtn.addEventListener('click', () => {
    setPhonemeScorer(false);
    renderPhonemeScorerButtons();
  });
  seg.append(onBtn, offBtn);
  row.append(label, seg);
  const logRow = settingsLogBtn.closest('.settings-row');
  if (logRow && logRow.parentElement === settingsCard) {
    settingsCard.insertBefore(row, logRow);
  } else {
    settingsCard.appendChild(row);
  }
}

function renderPhonemeScorerButtons(): void {
  const onBtn = document.getElementById('phonemeOnBtn');
  const offBtn = document.getElementById('phonemeOffBtn');
  if (!onBtn || !offBtn) return;
  const enabled = getPhonemeScorer();
  onBtn.classList.toggle('selected', enabled);
  offBtn.classList.toggle('selected', !enabled);
}


// 服务器打分开关行：动态创建（理由同音素模型行）。与音素模型行并列，
// 两个开关都关时打分会明确报“没有可用的打分通道”，不假装出分。
function ensureServerScorerRow(): void {
  if (document.getElementById('serverScorerRow')) return;
  const row = document.createElement('div');
  row.className = 'settings-row';
  row.id = 'serverScorerRow';
  const label = document.createElement('span');
  label.className = 'settings-label';
  label.textContent = '服务器打分';
  const seg = document.createElement('div');
  seg.className = 'seg';
  const onBtn = document.createElement('button');
  onBtn.id = 'serverOnBtn';
  onBtn.className = 'btn seg-btn';
  onBtn.textContent = '开';
  const offBtn = document.createElement('button');
  offBtn.id = 'serverOffBtn';
  offBtn.className = 'btn seg-btn';
  offBtn.textContent = '关';
  onBtn.addEventListener('click', () => {
    setServerScorer(true);
    renderServerScorerButtons();
  });
  offBtn.addEventListener('click', () => {
    setServerScorer(false);
    renderServerScorerButtons();
  });
  seg.append(onBtn, offBtn);
  row.append(label, seg);
  const logRow = settingsLogBtn.closest('.settings-row');
  if (logRow && logRow.parentElement === settingsCard) {
    settingsCard.insertBefore(row, logRow);
  } else {
    settingsCard.appendChild(row);
  }
}

function renderServerScorerButtons(): void {
  const onBtn = document.getElementById('serverOnBtn');
  const offBtn = document.getElementById('serverOffBtn');
  if (!onBtn || !offBtn) return;
  const enabled = getServerScorer();
  onBtn.classList.toggle('selected', enabled);
  offBtn.classList.toggle('selected', !enabled);
}

// 遮罩：JS 动态创建，不依赖 index.html（index.html 不热更新；OTA 只推 JS/CSS，
// 若 JS 引用了 HTML 里不存在的元素，$('...') 返回 null，设置就弹不出来）。
// 动态创建保证 OTA 补丁自包含。
function getSettingsBackdrop(): HTMLDivElement {
  let el = document.getElementById('settingsBackdrop') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'settingsBackdrop';
    el.className = 'settings-backdrop';
    el.hidden = true;
    document.body.appendChild(el);
    el.addEventListener('click', closeSettings);
  }
  return el;
}

function closeSettings(): void {
  settingsCard.hidden = true;
  getSettingsBackdrop().hidden = true;
}

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = settingsCard.hidden;
  settingsCard.hidden = !willOpen;
  getSettingsBackdrop().hidden = !willOpen;
  if (willOpen) {
    renderIpaButtons();
    ensurePhonemeScorerRow();
    renderPhonemeScorerButtons();
    ensureServerScorerRow();
    renderServerScorerButtons();
    renderVersion();
  }
});
// 点设置卡片内部不收回
settingsCard.addEventListener('click', (e) => e.stopPropagation());

// App 版本号（正式版号，随发布递增；设置页与页脚都显示，方便确认当前装的是哪版）。
export const APP_VERSION = '2.0';

// 版本显示：正式版号 + 热更新版（内置版与热更新版取较新者）
function renderVersion(): void {
  settingsVersion.textContent = `版本 ${APP_VERSION}（${getCurrentVersion() || '—'}）`;
}

// 检查更新：手动点按；有新版则下载并应用，下次启动生效；不自动重启、不强制重启。
settingsUpdateBtn.addEventListener('click', async () => {
  if (!otaSupported()) {
    settingsStatus.textContent = '当前版本已是最新';
    return;
  }
  settingsStatus.textContent = '检查中…';
  settingsUpdateBtn.setAttribute('disabled', 'true');
  try {
    const found = await checkForUpdate();
    if (!found) {
      settingsStatus.textContent = '已是最新';
      return;
    }
    const n = await applyUpdate(found.manifest);
    if (n > 0) {
      settingsStatus.textContent = '已更新，下次启动生效';
      renderVersion();
    } else {
      settingsStatus.textContent = '更新失败，稍后重试';
    }
  } catch {
    settingsStatus.textContent = '检查失败，稍后重试';
  } finally {
    settingsUpdateBtn.removeAttribute('disabled');
  }
});

ipaUkBtn.addEventListener('click', () => {
  setIpaType('uk');
  renderIpaButtons();
  if (current) {
    current.phonetic = ukPhonetic;
    ipaText.textContent = ukPhonetic || '—';
    setAccentLabel('uk');
  }
});

ipaUsBtn.addEventListener('click', () => {
  setIpaType('us');
  renderIpaButtons();
  if (current) void applyUsPhoneticIfNeeded(current.word);
});

settingsLogBtn.addEventListener('click', async () => {
  // 附带最新一次录音（myBlob），供诊断用；没有录音则只发日志文本。
  const ok = await uploadLogs(myBlob);
  settingsStatus.textContent = ok ? '日志已发送' : '日志发送失败';
});

playMineBtn.addEventListener('click', async () => {
  // 回放用 Web Audio API（解码 PCM 后播），不用 <audio> 元素：
  // MediaRecorder 的 WebM 头里没有 duration，<audio> 播它会失败（“回放失败”）。
  // decodeAudioData 不依赖 duration，能解就能播，和打分用同一路解码。
  try {
    if (playbackSource) { try { playbackSource.stop(); } catch {} playbackSource = null; setReplayIcon(false); return; }
    if (!myBlob) return;
    const pcm = myPcm ?? (await blobToPCM16k(myBlob));
    myPcm = pcm;
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, pcm.length, 16000);
    buf.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    playbackSource = src;
    src.onended = () => { playbackSource = null; setReplayIcon(false); void ctx.close().catch(() => {}); };
    src.start();
    setReplayIcon(true);
  } catch (e) { recStatus.textContent = '回放失败。'; }
});

/** 音素打分渲染（本地学生模型 / 服务器共用）：tokens 为识别到的音素（评估词元
 *  空间），expectedTokens 为目标词元。算分与对齐都走本地同一套逻辑，保证同一
 *  录音在两种通道下渲染与分数完全一致。返回界面分数（取整）。 */
function renderPhonemeScore(tokens: string[], expectedTokens: string[]): number {
  const { ops } = alignPhonemes(expectedTokens, tokens);
  const score = Math.round(scoreTokens(tokens, expectedTokens));
  recognizedText.textContent = `/${tokens.join(' ')}/`;
  fallbackNote.hidden = true;
  // 渲染音素对比
  const expHtml: string[] = [];
  const userHtml: string[] = [];
  const errs: string[] = [];
  for (const op of ops) {
    if (op.type === 'equal') {
      expHtml.push(`<span class="ok">${op.expected}</span>`);
      userHtml.push(`<span class="ok">${op.actual}</span>`);
    } else if (op.type === 'sub') {
      expHtml.push(`<span class="bad">${op.expected}</span>`);
      userHtml.push(`<span class="bad">${op.actual}</span>`);
      const d = describeOp(op);
      if (d) errs.push(d);
    } else if (op.type === 'del') {
      expHtml.push(`<span class="bad">${op.expected}</span>`);
      const d = describeOp(op);
      if (d) errs.push(d);
    } else if (op.type === 'ins') {
      userHtml.push(`<span class="extra">${op.actual}</span>`);
      const d = describeOp(op);
      if (d) errs.push(d);
    }
  }
  expectedPhonemes.innerHTML = expHtml.join('');
  userPhonemes.innerHTML = userHtml.join('');
  errorList.innerHTML = errs.length ? errs.map((e) => `<li>${e}</li>`).join('') : '<li class="all-ok">全部正确</li>';
  setScoreRing(score);
  setGrade(gradeForScore(score));
  resultEl.hidden = false;
  recStatus.textContent = '';
  modelStatus.textContent = '';
  return score;
}

/** 目标词元：把当前显示音标（本地词包 p 字段即 ECDICT 写法）归一化到评估词元空间，
 *  与桌面 evaluate_v5.py 的 gold 生成方式严格一致（如 /həˈləu/ -> [h, ə, l, o, ʊ]）。
 *  当前显示音标已按英式/美式设置切换过（美式模式下 current.phonetic 是美式音标）。 */
function currentTargetTokens(): string[] {
  return normalizeTargetTokens(current?.phonetic || '');
}

/** 音素学生模型打分（本地 ONNX）：解码录音的音素序列出分。出分成功返回 true；
 *  无目标词元 / 解码为空 / 任何失败都返回 false，由 runScore 继续下一通道。 */
async function tryStudentScore(pcm: Float32Array): Promise<boolean> {
  if (!current) return false;
  const expectedTokens = currentTargetTokens();
  if (expectedTokens.length === 0) {
    log('log', 'student scorer: 目标词无可用音标，跳过');
    return false;
  }
  try {
    const r = await scoreWithStudent(pcm, (m) => (modelStatus.textContent = m));
    if (r.tokens.length === 0) {
      log('log', `student scorer: 解码为空 (loadMs=${r.loadMs} inferMs=${r.inferMs})，跳过`);
      return false;
    }
    const score = renderPhonemeScore(r.tokens, expectedTokens);
    log(
      'log',
      `score: source=student word=${current.word} score=${score} loadMs=${r.loadMs} inferMs=${r.inferMs} phonemes=${r.tokens.join(' ')}`,
    );
    setState('scorer', 'student');
    return true;
  } catch (e) {
    log('error', `student scorer failed: ${(e as Error)?.message || e}`);
    modelStatus.textContent = '';
    return false;
  }
}

/** 服务器打分（自建服务，fp32 学生模型）：把录音原文件发过去出分。
 *  出分成功返回 true；任何失败返回 false 并写日志，由 runScore 回落本地通道。 */
async function tryServerScore(blob: Blob): Promise<boolean> {
  if (!current) return false;
  const expectedTokens = currentTargetTokens();
  if (expectedTokens.length === 0) {
    log('log', 'server scorer: 目标词无可用音标，跳过');
    return false;
  }
  try {
    const r = await scoreWithServer(blob, current.word, current.phonetic || '');
    if (r.tokens.length === 0) {
      log('log', `server scorer: 解码为空 (totalMs=${r.totalMs} serverMs=${r.serverMs})，回落本地`);
      return false;
    }
    const score = renderPhonemeScore(r.tokens, expectedTokens);
    log(
      'log',
      `score: source=server word=${current.word} score=${score} totalMs=${r.totalMs} serverMs=${r.serverMs} phonemes=${r.tokens.join(' ')}`,
    );
    setState('scorer', 'server');
    return true;
  } catch (e) {
    log('error', `server scorer failed, fallback: ${(e as Error)?.message || e}`);
    modelStatus.textContent = '';
    return false;
  }
}

async function runScore(): Promise<void> {
  if (!current || !myBlob) return;
  recStatus.textContent = '评分中';
  try {
    const pcm = myPcm ?? (await blobToPCM16k(myBlob));
    myPcm = pcm;
    if (pcm.length < 1600) throw new Error('录音太短，请完整读出单词');
    if (pcmPeak(pcm) < 0.01) throw new Error('没录到声音，请靠近麦克风再试一次');
    // 打分通道优先级：服务器（开关开 + 在线）→ 本地音素学生模型 → 明确失败。
    // 服务器优先模式下学生模型只作“已就绪”回落（probeStudentReady 只读缓存），
    // 绝不因回落触发 122MB 下载——弱机上下载+加载会闪退（已实证）。
    // 服务器开关关 = 显式本地模式：学生模型是主通道，沿用首次打分下载模型的流程。
    if (getServerScorer() && navigator.onLine && (await tryServerScore(myBlob))) return;
    if (getPhonemeScorer()) {
      if (getServerScorer()) {
        if (await probeStudentReady()) {
          if (await tryStudentScore(pcm)) return;
        } else {
          log('log', 'student scorer: 模型未就绪（未缓存），跳过本地回落（不触发下载）');
        }
      } else if (await tryStudentScore(pcm)) {
        return;
      }
    }
    log('error', 'score failed: no scoring channel available');
    throw new Error('打分失败：没有可用的打分通道，请检查网络或打分设置');
  } catch (e) {
    log('error', `score failed: ${(e as Error)?.message || e}`);
    // 之前这里吞掉了具体原因，统一只显示“评分失败，重试。”，
    // 用户无法区分是“没录到声音 / 录音太短 / 模型没加载上”。现在把具体原因显示出来。
    recStatus.textContent = e instanceof Error && e.message ? e.message : '评分失败，重试。';
    modelStatus.textContent = '';
  } finally {
  }
}


setPlayEnabled(false);
// 默认加载一个词，打开即用
lookup('hello');
