#!/usr/bin/env bash
# 打包 Android APK 前的准备：构建网页 + 把 Whisper 模型下载进 APK assets。
#
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
