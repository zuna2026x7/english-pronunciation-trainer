# 英语发音纠正 · Pronunciation Trainer

输入一个英文单词 → 听正确读音（三档语速）→ 跟读录音 → 打分 + 音标级定位哪里读错。

**零 Google 依赖**：不用 Web Speech API（Chrome 里走 Google）、不用 Google TTS / ML Kit / Firebase。`package.json` 零 Google 包。

## 在线使用

GitHub Pages 自动部署（push 到 `main` 即触发 Actions 编译 + 发布）。

本地运行：

```bash
npm install
npm run dev
# 打开 http://localhost:5173
```

构建：

```bash
npm run build
```

## 功能

- **查词**：输入单词，显示 IPA 音标、词性、释义，加载真人发音音频
- **三档播放**：正常 `1.0×` / 慢速 `0.65×` / 极慢 `0.40×`，变速不变调（`preservesPitch`）
- **录音评分**：浏览器本地 Whisper `Xenova/whisper-tiny.en`（ONNX，首次约 40MB 之后缓存）转写你的录音
- **音标对比**：标准 IPA vs 识别词 IPA，按音素 Levenshtein 对齐，高亮替换 / 漏读 / 多读，并给出文字提示，如“把 /θ/ 读成了 /s/”
- **练习记录**：仅保存在本设备 `localStorage`

## 评分原理

1. 标准音标来自 Free Dictionary API 的 IPA；你的录音由本地 Whisper 转写为文本，再查该识别词的 IPA。
2. 两串 IPA 按最长匹配切成音素，用 Levenshtein 对齐。
3. 分数 = 100 × (1 − 编辑距离 / max(标准音素数, 你的音素数))，整词识别一致时至少 90 分。
4. 若目标词或识别词暂无音标，走拼写相似度兜底并明确提示（非音素级）。

## 技术栈

- Vite + TypeScript + 原生 DOM（无框架、无 Google 包）
- 音频：Free Dictionary API（`dictionaryapi.dev`，免费、无需 key）
- 识别：`@xenova/transformers` + `Xenova/whisper-tiny.en`
- 部署：GitHub Actions → GitHub Pages

## 离线版 / Android APK（`offline-4500` 分支）

主站（`main`）是在线的；`offline-4500` 分支在保持 UI 与交互不变的前提下做到完全离线：

- **本地词表**：`public/data/cet4.json`（4500 词：ECDICT 的 CET-4 3846 词 + 高频常用词补足到 4500，含音标 + 释义）。
  词表来源：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT 许可）。重新生成：`npm run build:cet4`
  （`scripts/build-cet4.py`，默认下载 ECDICT CSV 并输出到 `public/data/cet4.json`）。
  查词先查本地包，本地没有再走在线词典/Wiktionary 兜底。
- **离线播放**：有真人音频播真人音频；没有/离线时用浏览器 TTS（`speechSynthesis`），
  连点仍循环 1.0 → 0.65 → 0.40 → 1.0，间隔 >2s 回到 1.0，不显示速度。
- **离线评分**：Whisper 模型（`Xenova/whisper-tiny.en`，约 44MB）在浏览器本地跑。
  网页版由 Service Worker（`public/sw.js`）在首次联网加载后缓存模型 + 词表 + 应用壳；
  App 版把模型打包进 APK（见下），安装后无需联网。
- **Service Worker**：缓存应用壳/词表/模型；导航用 network-first（联网取新 HTML，离线回退缓存）；
  `/api/` 不缓存；`/models/` 与 `.wasm`/`.onnx` 用 cache-first。

### 打包 Android APK

```bash
npm install
bash scripts/prepare-capacitor.sh   # 构建网页 + 同步 + 下载 Whisper 模型进 APK assets（约 44MB，不进 git）
cd android && ./gradlew assembleDebug
# APK：android/app/build/outputs/apk/debug/app-debug.apk（约 65–70MB：模型 44MB + ONNX Runtime WASM 21MB + 网页/词表约 2MB）
```

也可以直接推到 `offline-4500` 分支，GitHub Actions（`.github/workflows/android.yml`）会自动构建并上传
`pronunciation-debug-apk` 产物。本机无 Android SDK 时用 CI 构建即可。

- App ID：`uk.benext.speak`，应用名“发音”；`android/app/src/main/AndroidManifest.xml` 已加 `RECORD_AUDIO`
  （首次录音时系统弹出麦克风授权）。
- 模型打包方式：**模型文件打包进 APK**（构建时从 Hugging Face 下载到
  `android/app/src/main/assets/public/models/...`，不提交到 git），Capacitor 以 `https://localhost` 提供，
  应用内按同源 `/models/` 加载。不是“首次启动再下载”的备选方案。
- 注意：不要把该分支部署到线上主站（`speak.benext.uk` 仍由 `main` 提供）。

## 局限

- Whisper 对口音、噪音敏感；识别不一定 100% 准确，请结合回放复听。
- 个别单词无真人音频时播放按钮禁用，但仍可录音评分。
- 极慢速 0.40× 在个别浏览器上音质略有损失，属浏览器变速算法限制。
- 需在 https 或 localhost 下使用麦克风。

## License

MIT
