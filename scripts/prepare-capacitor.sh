#!/usr/bin/env bash
# 打包 Android APK 前的准备：下载真人语音 + 构建网页 + 把 Whisper 模型下载进 APK assets。
#
# 真人语音打包方式：音频文件不进 git（4500 词，约 100MB），构建时由
#   scripts/download-audio.py 从 Wiktionary（Wikimedia Commons OGG，优先 en-us）
#   下载到 public/data/audio/（manifest.json 记录哪些词有音频），Vite 构建时
#   一并打进 dist/，Capacitor 同步进 APK assets，App 内优先用本地音频，离线可用。
#   无真人音频的词仍走 TTS 兜底。SKIP_AUDIO=1 可跳过音频下载（快速本地构建）。
# 模型打包方式：模型文件不进 git（44MB），构建时下载到
#   android/app/src/main/assets/public/models/...（已被 .gitignore 排除），
# Capacitor 以 https://localhost 提供这些文件，应用内 transformers.js
# 走同源 /models/ 加载，安装后无需联网即可评分。
# 模型来源：Hugging Face Xenova/whisper-tiny.en（与线上 speak.benext.uk 用的同一份）。
#
# 用法：
#   bash scripts/prepare-capacitor.sh
#   cd android && ./gradlew assembleDebug   # 或在 Android Studio 里点 Run
#   # APK: android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${SKIP_AUDIO:-0}" != "1" ]; then
  echo "== 0/3 下载真人语音进 public/data/audio/（约 100MB，已下载的跳过） =="
  python3 scripts/download-audio.py
else
  echo "== 0/3 跳过真人语音（SKIP_AUDIO=1），播放走在线/TTS 兜底 =="
fi

echo "== 0.5/3 复制 ONNX WASM 后端进 public/models/wasm/（21MB，随网页一起打进 APK，离线可用） =="
mkdir -p public/models/wasm
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm public/models/wasm/

echo "== 1/3 构建网页 =="
npm run build

echo "== 2/3 同步到 Capacitor Android =="
npx cap sync android

echo "== 3/3 下载 Whisper 模型进 APK assets（约 44MB，未下载过的才下载） =="
MODEL_SRC="https://huggingface.co/Xenova/whisper-tiny.en/resolve/main"
DEST="android/app/src/main/assets/public/models/Xenova/whisper-tiny.en/resolve/main"
mkdir -p "$DEST/onnx"
FILES=(
  config.json
  generation_config.json
  preprocessor_config.json
  tokenizer.json
  tokenizer_config.json
  vocab.json
  merges.txt
  special_tokens_map.json
  added_tokens.json
  normalizer.json
  quant_config.json
  onnx/encoder_model_quantized.onnx
  onnx/decoder_model_merged_quantized.onnx
)
for f in "${FILES[@]}"; do
  if [ -s "$DEST/$f" ]; then
    echo "skip (exists): $f"
  else
    echo "download: $f"
    curl -fL --retry 2 -o "$DEST/$f" "$MODEL_SRC/$f"
  fi
done
du -sh "$DEST"
echo "完成。构建 APK：cd android && ./gradlew assembleDebug"
