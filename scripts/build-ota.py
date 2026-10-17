#!/usr/bin/env python3
"""热更新（OTA）发布脚本：生成清单 + 变更文件暂存，供人工 rsync 到服务器。

工作方式：
- 对比 dist/（本次构建产物）与 scripts/ota-baseline.json（上次发布时的完整状态），
  只把新增/变更的文件列入新清单（delta），版本号自动递增（YYYYMMDD.N）。
- 变更文件复制到 ota-publish/<path>（与服务器 dist/updates/ 下结构一致），
  清单写到 ota-publish/manifest.json。
- 发布 = 先 rsync ota-publish/ 下的文件到服务器，再 rsync manifest.json（清单最后，
  避免客户端拉到指向尚不存在文件的清单）。
- 本地首次运行用 --init-baseline：把当前 dist/ 快照为基线并提交到 git，
  之后每次发布都基于该基线做 diff。

可热更新的文件（其余随 APK 走，不进清单）：
- dist/assets/*.js、dist/assets/*.css（入口 JS/CSS；入口 JS 是单文件 bundle，无动态 chunk）
- dist/data/cet4.json、dist/data/audio/manifest.json
- dist/data/audio/*.{ogg,mp3,wav}（新增/变更的音频）
不含：index.html（引导脚本寄生在它上面）、sw.js、manifest.webmanifest、
模型 ONNX/WASM（随 APK 走）。

用法：
  # 首次：快照当前 dist 为基线（构建 APK 的那次 dist），提交 baseline 到 git
  python3 scripts/build-ota.py --init-baseline
  # 发布热更新：改代码 -> npm run build -> 本脚本 -> 检查 ota-publish/ -> rsync 到服务器
  python3 scripts/build-ota.py
  rsync -av ota-publish/ root@198.44.81.247:/opt/pronunciation-trainer/dist/updates/ --exclude=manifest.json
  rsync -av ota-publish/manifest.json root@198.44.81.247:/opt/pronunciation-trainer/dist/updates/
  # 下一个完整 APK 构建时：把 public/updates/manifest.json 的 version  bump 到已发布的版本，
  # files 置 []（APK 已包含该版本内容），并重新 --init-baseline。

注意：本脚本不自动部署（不碰线上服务器），只生成待发布产物，由人工检查后 rsync。
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
BASELINE = os.path.join(ROOT, "scripts", "ota-baseline.json")
OUT = os.path.join(ROOT, "ota-publish")

# 可热更新的相对路径（相对于 dist/）
INCLUDE_JS_CSS = ("assets/",)  # dist/assets/*.js, *.css
INCLUDE_DATA = ("data/cet4.json", "data/audio/manifest.json")
INCLUDE_AUDIO_PREFIX = "data/audio/"
AUDIO_EXTS = (".ogg", ".mp3", ".wav")


def is_ota_file(rel: str) -> bool:
    rel = rel.replace(os.sep, "/")
    if rel.startswith(INCLUDE_JS_CSS) and (rel.endswith(".js") or rel.endswith(".css")):
        return True
    if rel in INCLUDE_DATA:
        return True
    if rel.startswith(INCLUDE_AUDIO_PREFIX) and rel.lower().endswith(AUDIO_EXTS):
        return True
    return False


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_dist() -> dict:
    """扫描 dist/，返回 {rel_path: {sha256, size}}（仅可热更新文件）。"""
    out = {}
    for dirpath, _dirs, files in os.walk(DIST):
        for fn in files:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, DIST).replace(os.sep, "/")
            if not is_ota_file(rel):
                continue
            out[rel] = {"sha256": sha256_file(full), "size": os.path.getsize(full)}
    return out


def load_baseline() -> dict:
    if not os.path.exists(BASELINE):
        return {"version": "", "files": {}}
    with open(BASELINE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_baseline(version: str, files: dict) -> None:
    with open(BASELINE, "w", encoding="utf-8") as f:
        json.dump({"version": version, "files": files}, f, ensure_ascii=False, indent=1)
        f.write("\n")


def bump_version(prev: str) -> str:
    """YYYYMMDD.N 递增：同日则 N+1，换日则从 .1 开始。"""
    today = date.today().strftime("%Y%m%d")
    try:
        d, n = prev.split(".")
        if d == today:
            return f"{today}.{int(n) + 1}"
    except Exception:
        pass
    return f"{today}.1"


def main() -> int:
    ap = argparse.ArgumentParser(description="OTA 发布脚本：生成清单 + 变更文件暂存")
    ap.add_argument("--init-baseline", action="store_true", help="快照当前 dist 为基线，不生成更新")
    args = ap.parse_args()
    if not os.path.isdir(DIST):
        print(f"ERROR: dist/ 不存在，先跑 npm run build", file=sys.stderr)
        return 1
    current = scan_dist()
    baseline = load_baseline()
    if args.init_baseline:
        # 基线版本 = public/updates/manifest.json 的版本（APK 内置版）
        manifest_path = os.path.join(ROOT, "public", "updates", "manifest.json")
        try:
            with open(manifest_path, encoding="utf-8") as f:
                ver = json.load(f).get("version", "")
        except Exception:
            ver = ""
        save_baseline(ver, current)
        print(f"baseline 已快照：version={ver}，文件 {len(current)} 个")
        return 0
    # diff：新增或 sha 变化的文件
    changed = []
    for rel, info in sorted(current.items()):
        old = baseline.get("files", {}).get(rel)
        if not old or old.get("sha256") != info["sha256"]:
            changed.append(rel)
    if not changed:
        print("无变更：dist 与基线一致，不生成更新。")
        return 0
    # 入口 JS/CSS 按 role 标记（引导脚本按 role 找；数据文件按 path 找）。
    # 入口 = dist/index.html 里 <script type="module" src> 与 <link rel="stylesheet" href> 指向的文件。
    entry_js = ""
    entry_css = ""
    try:
        with open(os.path.join(DIST, "index.html"), encoding="utf-8") as f:
            html = f.read()
        import re

        m = re.search(r'<script[^>]+type="module"[^>]+src="\.?/?([^"]+)"', html)
        if m:
            entry_js = m.group(1)
        m = re.search(r'<link[^>]+rel="stylesheet"[^>]+href="\.?/?([^"]+)"', html)
        if m:
            entry_css = m.group(1)
    except Exception:
        pass
    new_version = bump_version(baseline.get("version", ""))
    files = []
    for rel in changed:
        entry = {"path": rel, "sha256": current[rel]["sha256"], "size": current[rel]["size"]}
        if rel == entry_js:
            entry["role"] = "entry-js"
        elif rel == entry_css:
            entry["role"] = "entry-css"
        files.append(entry)
    # 暂存变更文件 + 清单
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    for rel in changed:
        src = os.path.join(DIST, rel)
        dst = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
    manifest = {"version": new_version, "files": files}
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
        f.write("\n")
    save_baseline(new_version, current)
    total = sum(current[r]["size"] for r in changed)
    print(f"新版 {new_version}：变更 {len(changed)} 个文件，共 {total / 1024:.0f} KB")
    for r in changed:
        print(f"  {r} ({current[r]['size'] / 1024:.0f} KB)")
    print(f"待发布产物在 ota-publish/（先 rsync 文件，再 rsync manifest.json）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
