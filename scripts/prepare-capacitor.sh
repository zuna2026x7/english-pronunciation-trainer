#!/usr/bin/env bash
# 打包 Android APK 前的准备：下载真人语音 + 复制 ONNX WASM + 构建网页 + 同步 Capacitor。
#
# 真人语音打包方式：音频文件不进 git（4500 词，约 100MB），构建时由
#   scripts/download-audio.py 从 Wiktionary（Wikimedia Commons OGG，优先 en-us）
#   下载到 public/data/audio/（manifest.json 记录哪些词有音频），Vite 构建时
#   一并打进 dist/，Capacitor 同步进 APK assets，App 内优先用本地音频，离线可用。
#   无真人音频的词仍走 TTS 兜底。SKIP_AUDIO=1 可跳过音频下载（快速本地构建）。
# 打分模型：本地音素学生模型（student_int8.onnx）不打包进 APK，首次本地打分时
#   从 speak.benext.uk/models/ 下载并缓存（见 src/phoneme-worker.ts）；
#   服务器打分走自建服务（见 src/server-scorer.ts）。Whisper 已于 2026-10-22 移除，
#   不再有模型文件随包下载这一步。
#
# 用法：
#   bash scripts/prepare-capacitor.sh
#   cd android && ./gradlew assembleDebug   # 或在 Android Studio 里点 Run
#   # APK: android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${SKIP_AUDIO:-0}" != "1" ]; then
  echo "== 0/2 下载真人语音进 public/data/audio/（约 100MB，已下载的跳过） =="
  python3 scripts/download-audio.py
else
  echo "== 0/2 跳过真人语音（SKIP_AUDIO=1），播放走在线/TTS 兜底 =="
fi

echo "== 0.5/2 复制 ONNX WASM 后端（标准版一对）进 public/models/wasm/（音素学生模型 worker 运行时加载，离线可用） =="
mkdir -p public/models/wasm
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs public/models/wasm/

echo "== 1/2 构建网页 =="
npm run build

echo "== 2/2 同步到 Capacitor Android =="
npx cap sync android

echo "完成。构建 APK：cd android && ./gradlew assembleDebug"
