import { fetchWord, fetchPhoneticFor, fetchWikimediaAudio, pickUsPhonetic, fetchUsPhonetic, type WordInfo } from './dictionary';
import { playAtRate, SPEEDS } from './audio';
import { Recorder, blobToPCM16k, pcmPeak } from './recorder';
import { transcribePCM, warmupModel } from './whisper';
import { tokenizeIPA, alignPhonemes, scoreFromAlignment, gradeForScore, describeOp } from './ipa';
import { lookupLocal, speakTTS } from './offline';
import { initLogger, log, setState, uploadLogs } from './logger';
import { getIpaType, setIpaType } from './settings';
import { autoCheckAndApply, checkForUpdate, applyUpdate, getCurrentVersion, otaSupported } from './updater';

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
const myAudio = $('myAudio') as HTMLAudioElement;
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
    }
    return;
  }
  try {
    const us = await fetchUsPhonetic(word);
    if (us && current?.word.toLowerCase() === word.toLowerCase()) {
      current.phonetic = us;
      ipaText.textContent = us;
    }
  } catch {
    // 保持英式
  }
}

async function lookup(word: string) {
  lookupStatus.textContent = '';
  lookupBtn.setAttribute('disabled', 'true');
  try {
    // 离线优先：先查本地 4500 词包（离线可用）；本地没有再走在线词典/Wiktionary 兜底。
    const local = await lookupLocal(word);
    const fromLocal = !!local;
    const info = local ?? (await fetchWord(word));
    log('log', `lookup done: ${word} fromLocal=${fromLocal}`);
    current = info;
    wordTitle.textContent = info.word;
    posBadge.textContent = info.pos || '';
    posBadge.style.display = info.pos ? '' : 'none';
    ukPhonetic = info.phonetic || '';
    ipaText.textContent = info.phonetic || '—';
    // 美式模式：后台升级美式音标（取不到保持英式，不动其他显示）
    void applyUsPhoneticIfNeeded(info.word);
    defText.textContent = info.definition ? `${info.pos ? info.pos + ' · ' : ''}${info.definition}` : '';
    // 释义默认隐藏：用户只想看英文 + 听发音，翻译/释义点“释义”才显示
    defText.hidden = true;
    playSpeedIdx = 0;
    lastPlayTapAt = 0;
    defToggleBtn.hidden = !info.definition;
    defToggleBtn.textContent = '释义 ▾';
    wordCard.hidden = false;
    practiceCard.hidden = false;
    resultEl.hidden = true;
    recStatus.textContent = '';
    myBlob = null;
    myPcm = null;
    playMineBtn.hidden = true;
    myAudio.hidden = true;
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
    // 后台预热识别模型，评分时更快
    warmupModel((m) => { modelStatus.textContent = m; setState('model', m || 'ready'); });
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
  if (e.key === 'Enter') lookup(wordInput.value);
});
defToggleBtn.addEventListener('click', () => {
  defText.hidden = !defText.hidden;
  defToggleBtn.textContent = defText.hidden ? '释义 ▾' : '释义 ▴';
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
  try { await playWithFallback(rate); } catch (e) { lookupStatus.textContent = '播放失败，稍后重试。'; }
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
  try {
    const blob = await recorder.stop();
    myBlob = blob;
    myPcm = null;
    const url = URL.createObjectURL(blob);
    myAudio.src = url;
    playMineBtn.hidden = false;
    recStatus.textContent = '评分中';
    await runScore();
  } catch (e) {
    recStatus.textContent = '停止失败，重试。';
  } finally {
    recBtn.classList.remove('recording');
  }
}

recBtn.addEventListener('pointerdown', (e) => {
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

settingsBtn.addEventListener('click', () => {
  settingsCard.hidden = !settingsCard.hidden;
  renderIpaButtons();
  renderVersion();
});

// 版本显示：当前生效版（内置版与热更新版取较新者）
function renderVersion(): void {
  settingsVersion.textContent = `版本 ${getCurrentVersion() || '—'}`;
}

// 检查更新：手动点按；有新版则下载并应用，下次启动生效；不自动重启、不强制重启。
settingsUpdateBtn.addEventListener('click', async () => {
  if (!otaSupported()) {
    settingsStatus.textContent = '当前版本已是最新';
    return;
  }
  settingsStatus.textContent = '';
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
  try {
    if (!myAudio.paused) { myAudio.pause(); return; }
    myAudio.currentTime = 0;
    await myAudio.play();
  } catch (e) { recStatus.textContent = '回放失败。'; }
});

function letterDistance(a: string, b: string): number {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[n][m];
}

async function runScore(): Promise<void> {
  if (!current || !myBlob) return;
  recStatus.textContent = '评分中';
  try {
    const pcm = myPcm ?? (await blobToPCM16k(myBlob));
    myPcm = pcm;
    if (pcm.length < 1600) throw new Error('录音太短，请完整读出单词');
    if (pcmPeak(pcm) < 0.01) throw new Error('没录到声音，请靠近麦克风再试一次');
    const text = await transcribePCM(pcm, (m) => (modelStatus.textContent = m));
    const recognizedFull = text || '';
    const recognizedWord = recognizedFull.split(/\s+/)[0] || '';
    recognizedText.textContent = recognizedFull || '—';
    const target = current.word.toLowerCase();
    const wordMatch = recognizedWord === target;

    const expectedTokens = tokenizeIPA(current.phonetic || '');
    let score: number;
    let fallback = false;

    if (!recognizedWord) {
      score = 0;
      fallback = true;
      fallbackNote.hidden = false;
      fallbackNote.textContent = '未识别出内容，0 分。';
      expectedPhonemes.innerHTML = '';
      userPhonemes.innerHTML = '';
      errorList.innerHTML = '<li>未识别出内容</li>';
    } else if (expectedTokens.length === 0) {
      // 目标词无音标：走拼写相似度兜底
      const d = letterDistance(target, recognizedWord);
      score = Math.max(0, Math.round(100 * (1 - d / Math.max(target.length, recognizedWord.length, 1))));
      fallback = true;
      fallbackNote.hidden = false;
      fallbackNote.textContent = '无音标，按拼写评分。';
      expectedPhonemes.innerHTML = `<span>${current.word}</span>`;
      userPhonemes.innerHTML = `<span>${recognizedWord}</span>`;
      errorList.innerHTML = wordMatch ? '<li>整词识别一致</li>' : `<li>识别为 “${recognizedWord}”，与目标 “${target}” 拼写有差异</li>`;
    } else {
      // 识别词的音标：美式模式先在线取 -us 音标，取不到回落英式；
      // 英式：先查本地词包（离线可用），没有再走在线词典
      let recogPhonetic = '';
      if (getIpaType() === 'us' && navigator.onLine) {
        recogPhonetic = await fetchUsPhonetic(recognizedWord);
      }
      if (!recogPhonetic) {
        const localRecog = await lookupLocal(recognizedWord);
        recogPhonetic = localRecog?.phonetic ?? (await fetchPhoneticFor(recognizedWord));
      }
      const actualTokens = tokenizeIPA(recogPhonetic || '');
      if (actualTokens.length === 0) {
        const d = letterDistance(target, recognizedWord);
        score = Math.max(0, Math.round(100 * (1 - d / Math.max(target.length, recognizedWord.length, 1))));
        fallback = true;
        fallbackNote.hidden = false;
        fallbackNote.textContent = '无音标，按拼写评分。';
        expectedPhonemes.innerHTML = expectedTokens.map((t) => `<span>${t}</span>`).join('');
        userPhonemes.innerHTML = `<span>${recognizedWord}</span>`;
        errorList.innerHTML = `<li>识别为 “${recognizedWord}”</li>`;
      } else {
        fallback = false;
        fallbackNote.hidden = true;
        const { ops, distance } = alignPhonemes(expectedTokens, actualTokens);
        score = scoreFromAlignment(expectedTokens.length, actualTokens.length, distance, wordMatch);
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
        errorList.innerHTML = errs.length ? errs.map((e) => `<li>${e}</li>`).join('') : '<li>全部正确 🎉</li>';
      }
    }

    log('log', `score: word=${current?.word} score=${score} recognized=${recognizedFull}`);
    scoreNum.textContent = String(score);
    gradeText.textContent = gradeForScore(score);
    resultEl.hidden = false;
    recStatus.textContent = '';
  } catch (e) {
    log('error', `score failed: ${(e as Error)?.message || e}`);
    // 之前这里吞掉了具体原因，统一只显示“评分失败，重试。”，
    // 用户无法区分是“没录到声音 / 录音太短 / 模型没加载上”。现在把具体原因显示出来。
    recStatus.textContent = e instanceof Error && e.message ? e.message : '评分失败，重试。';
  } finally {
  }
}


setPlayEnabled(false);
// 默认加载一个词，打开即用
lookup('hello');
