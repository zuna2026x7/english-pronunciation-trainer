import { fetchWord, fetchPhoneticFor, fetchWikimediaAudio, type WordInfo } from './dictionary';
import { playAtRate, RATES } from './audio';
import { Recorder, blobToPCM16k, pcmPeak } from './recorder';
import { transcribePCM, warmupModel } from './whisper';
import { tokenizeIPA, alignPhonemes, scoreFromAlignment, gradeForScore, describeOp } from './ipa';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const wordInput = $('wordInput') as HTMLInputElement;
const lookupBtn = $('lookupBtn');
const lookupStatus = $('lookupStatus');
const wordCard = $('wordCard');
const wordTitle = $('wordTitle');
const posBadge = $('posBadge');
const ipaText = $('ipaText');
const defText = $('defText');
const refAudio = $('refAudio') as HTMLAudioElement;
const playNormal = $('playNormal');
const playSlow = $('playSlow');
const playVerySlow = $('playVerySlow');
const practiceCard = $('practiceCard');
const recBtn = $('recBtn');
const playMineBtn = $('playMineBtn');
const scoreBtn = $('scoreBtn');
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
const historyList = $('historyList');
const clearHistoryBtn = $('clearHistoryBtn');

let current: WordInfo | null = null;
let recorder: Recorder | null = null;
let myBlob: Blob | null = null;
let myPcm: Float32Array | null = null;
let triedWikimediaFallback = false;

// 音频兜底：dictionaryapi /media/ 曾 522/超时，自动切 Wikimedia Commons 直链（ogg）再播一次。
// 只兜底一次，避免循环。refAudio 的 error 事件由 playAtRate 的 play() 失败触发时也会走到这里。
refAudio.addEventListener('error', async () => {
  if (!current?.audioSourceUrl || triedWikimediaFallback) return;
  triedWikimediaFallback = true;
  try {
    lookupStatus.textContent = '主音频源暂时不可用，正在尝试 Wikimedia 兜底音频…';
    const fb = await fetchWikimediaAudio(current.audioSourceUrl);
    refAudio.src = fb;
    lookupStatus.textContent = '已切换到 Wikimedia 兜底音频，请再点播放。';
  } catch (e) {
    lookupStatus.textContent = `主音频与 Wikimedia 兜底都失败了：${(e as Error).message}（词典音标仍可用于跟读评分）`;
  }
});

type HistItem = { word: string; score: number; recognized: string; time: string };
const HIST_KEY = 'ept_history_v1';

function loadHistory(): HistItem[] {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveHistory(items: HistItem[]) {
  localStorage.setItem(HIST_KEY, JSON.stringify(items.slice(0, 30)));
}
function renderHistory() {
  const items = loadHistory();
  historyList.innerHTML = items.length
    ? items.map((h) => `<li><span><strong>${h.word}</strong> · 识别为 ${h.recognized || '—'}</span><span>${h.score}分 · ${h.time}</span></li>`).join('')
    : '<li>暂无记录，练一次就会出现在这里。</li>';
}

function setPlayEnabled(enabled: boolean) {
  [playNormal, playSlow, playVerySlow].forEach((b) => ((b as HTMLButtonElement).disabled = !enabled));
}

async function lookup(word: string) {
  lookupStatus.textContent = `正在查 “${word}”…`;
  lookupBtn.setAttribute('disabled', 'true');
  try {
    const info = await fetchWord(word);
    current = info;
    wordTitle.textContent = info.word;
    posBadge.textContent = info.pos || '';
    posBadge.style.display = info.pos ? '' : 'none';
    ipaText.textContent = info.phonetic ? `${info.phonetic}  ${info.phonetic.includes('/') ? '' : ''}` : '（暂无音标）';
    defText.textContent = info.definition ? `${info.pos ? info.pos + ' · ' : ''}${info.definition}` : '';
    wordCard.hidden = false;
    practiceCard.hidden = false;
    resultEl.hidden = true;
    recStatus.textContent = '';
    myBlob = null;
    myPcm = null;
    playMineBtn.setAttribute('disabled', 'true');
    scoreBtn.setAttribute('disabled', 'true');
    myAudio.hidden = true;
    if (info.audio) {
      triedWikimediaFallback = false;
      refAudio.src = info.audio;
      setPlayEnabled(true);
      lookupStatus.textContent = '已加载真人发音，可以点三档播放试听。';
    } else {
      refAudio.removeAttribute('src');
      setPlayEnabled(false);
      lookupStatus.textContent = '已找到词条，但该词暂无真人发音音频（仍可录音评分）。';
    }
    // 后台预热识别模型，评分时更快
    warmupModel((m) => (modelStatus.textContent = m));
    wordInput.value = info.word;
  } catch (e) {
    lookupStatus.textContent = `查词失败：${(e as Error).message}`;
  } finally {
    lookupBtn.removeAttribute('disabled');
  }
}

lookupBtn.addEventListener('click', () => lookup(wordInput.value));
wordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lookup(wordInput.value);
});
document.getElementById('exampleChips')?.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const w = t.dataset?.word;
  if (w) lookup(w);
});

async function playWithFallback(rate: number) {
  try {
    await playAtRate(refAudio, rate);
  } catch (e) {
    // 主音频加载失败时，error 监听已尝试切 Wikimedia；这里再兜底一次（若 error 未触发）
    if (current?.audioSourceUrl && !triedWikimediaFallback) {
      triedWikimediaFallback = true;
      try {
        const fb = await fetchWikimediaAudio(current.audioSourceUrl);
        refAudio.src = fb;
        await playAtRate(refAudio, rate);
        lookupStatus.textContent = '已切换到 Wikimedia 兜底音频。';
        return;
      } catch {
        // 落到下方统一报错
      }
    }
    throw e;
  }
}

playNormal.addEventListener('click', async () => {
  try { await playWithFallback(RATES.normal); } catch (e) { lookupStatus.textContent = `播放失败：${(e as Error).message}（可试 Wikimedia 兜底，或稍后重试）`; }
});
playSlow.addEventListener('click', async () => {
  try { await playWithFallback(RATES.slow); } catch (e) { lookupStatus.textContent = `播放失败：${(e as Error).message}（可试 Wikimedia 兜底，或稍后重试）`; }
});
playVerySlow.addEventListener('click', async () => {
  try { await playWithFallback(RATES.verySlow); } catch (e) { lookupStatus.textContent = `播放失败：${(e as Error).message}（可试 Wikimedia 兜底，或稍后重试）`; }
});

recBtn.addEventListener('click', async () => {
  if (recorder?.isRecording) {
    recBtn.textContent = '● 正在停止…';
    recBtn.setAttribute('disabled', 'true');
    try {
      const blob = await recorder.stop();
      myBlob = blob;
      myPcm = null;
      const url = URL.createObjectURL(blob);
      myAudio.src = url;
      myAudio.hidden = false;
      playMineBtn.removeAttribute('disabled');
      scoreBtn.removeAttribute('disabled');
      recStatus.textContent = '录音已保存，可以先回放，再点“打分 & 找错误”。';
    } catch (e) {
      recStatus.textContent = `停止录音失败：${(e as Error).message}`;
    } finally {
      recBtn.textContent = '● 开始录音';
      recBtn.removeAttribute('disabled');
    }
    return;
  }
  if (!current) {
    recStatus.textContent = '请先查一个单词。';
    return;
  }
  recorder = new Recorder();
  try {
    await recorder.start();
    recBtn.textContent = '■ 停止录音';
    recStatus.textContent = `正在录音：请朗读 “${current.word}”…`;
    resultEl.hidden = true;
  } catch (e) {
    recStatus.textContent = `无法开始录音：${(e as Error).message}（请允许麦克风权限，并用 https 或 localhost 打开页面）`;
  }
});

playMineBtn.addEventListener('click', async () => {
  try { await myAudio.play(); } catch (e) { recStatus.textContent = `播放我的录音失败：${(e as Error).message}`; }
});

function letterDistance(a: string, b: string): number {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[n][m];
}

scoreBtn.addEventListener('click', async () => {
  if (!current || !myBlob) return;
  scoreBtn.setAttribute('disabled', 'true');
  recStatus.textContent = '正在处理录音…';
  try {
    const pcm = myPcm ?? (await blobToPCM16k(myBlob));
    myPcm = pcm;
    if (pcm.length < 1600) throw new Error('录音太短，请完整读出单词');
    if (pcmPeak(pcm) < 0.01) throw new Error('没录到声音，请靠近麦克风再试一次');
    const text = await transcribePCM(pcm, (m) => (modelStatus.textContent = m));
    const recognizedFull = text || '';
    const recognizedWord = recognizedFull.split(/\s+/)[0] || '';
    recognizedText.textContent = recognizedFull || '（未识别出内容）';
    const target = current.word.toLowerCase();
    const wordMatch = recognizedWord === target;

    const expectedTokens = tokenizeIPA(current.phonetic || '');
    let score: number;
    let fallback = false;

    if (!recognizedWord) {
      score = 0;
      fallback = true;
      fallbackNote.hidden = false;
      fallbackNote.textContent = '未识别出单词，按 0 分计，请在安静环境下再试一次。';
      expectedPhonemes.innerHTML = '';
      userPhonemes.innerHTML = '';
      errorList.innerHTML = '<li>未识别出内容</li>';
    } else if (expectedTokens.length === 0) {
      // 目标词无音标：走拼写相似度兜底
      const d = letterDistance(target, recognizedWord);
      score = Math.max(0, Math.round(100 * (1 - d / Math.max(target.length, recognizedWord.length, 1))));
      fallback = true;
      fallbackNote.hidden = false;
      fallbackNote.textContent = '目标词暂无标准音标，本次按拼写相似度兜底评分（非音素级）。';
      expectedPhonemes.innerHTML = `<span>${current.word}</span>`;
      userPhonemes.innerHTML = `<span>${recognizedWord}</span>`;
      errorList.innerHTML = wordMatch ? '<li>整词识别一致</li>' : `<li>识别为 “${recognizedWord}”，与目标 “${target}” 拼写有差异</li>`;
    } else {
      const recogPhonetic = await fetchPhoneticFor(recognizedWord);
      const actualTokens = tokenizeIPA(recogPhonetic || '');
      if (actualTokens.length === 0) {
        const d = letterDistance(target, recognizedWord);
        score = Math.max(0, Math.round(100 * (1 - d / Math.max(target.length, recognizedWord.length, 1))));
        fallback = true;
        fallbackNote.hidden = false;
        fallbackNote.textContent = `识别词 “${recognizedWord}” 暂无音标，本次按拼写相似度兜底评分（非音素级）。`;
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
        errorList.innerHTML = errs.length ? errs.map((e) => `<li>${e}</li>`).join('') : '<li>全部音素正确 🎉</li>';
      }
    }

    scoreNum.textContent = String(score);
    gradeText.textContent = gradeForScore(score);
    resultEl.hidden = false;
    recStatus.textContent = fallback ? '已按兜底方式评分（见提示）。' : '评分完成，请看音标对比与错误列表。';
    const hist = loadHistory();
    hist.unshift({ word: current.word, score, recognized: recognizedWord, time: new Date().toLocaleString() });
    saveHistory(hist);
    renderHistory();
  } catch (e) {
    recStatus.textContent = `评分失败：${(e as Error).message}`;
  } finally {
    scoreBtn.removeAttribute('disabled');
  }
});

clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem(HIST_KEY);
  renderHistory();
});

renderHistory();
setPlayEnabled(false);
// 默认加载一个词，打开即用
lookup('hello');
