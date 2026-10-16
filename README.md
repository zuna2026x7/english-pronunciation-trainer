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

## 局限

- Whisper 对口音、噪音敏感；识别不一定 100% 准确，请结合回放复听。
- 个别单词无真人音频时播放按钮禁用，但仍可录音评分。
- 极慢速 0.40× 在个别浏览器上音质略有损失，属浏览器变速算法限制。
- 需在 https 或 localhost 下使用麦克风。

## License

MIT
