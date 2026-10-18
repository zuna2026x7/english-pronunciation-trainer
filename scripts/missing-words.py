#!/usr/bin/env python3
"""缺词上报的打包工具：拉取服务器上记录的缺词，核查后生成待补词清单。

流程：
  1. App 查词时本地词包没有 -> POST /api/log/missing-word 记录 {word, foundOnline, ts}。
     foundOnline=true 表示在线词典查到了（真实存在的词，打包时优先补）；
     false 表示在线也查不到（多为拼写错误或生僻词，打包时人工核查）。
  2. 打包前：python3 scripts/missing-words.py [--fetch]
     拉取服务器 logs/missing-words.jsonl（--fetch 用 scp；不带 --fetch 则读本地 missing-words.jsonl），
     聚合计数、排除已在词表的词、在线核查音标 + 释义，生成 missing-words-review.json。
  3. 人工审 review 文件：删掉不要的行（错字 / 不想要的词），保留要补的。
  4. python3 scripts/missing-words.py --apply missing-words-review.json
     把保留的词合并进 public/data/cet4.json（按字母序，带音标 + 英文释义）。
     其中查不到释义的行会被跳过并提示（无法合并）。
  5. 按提示跑下载音频 + 构建 + OTA 发布：
     python3 scripts/download-audio.py && npm run build && python3 scripts/build-ota.py

只用 Python 标准库。--fetch 默认的服务器地址与密钥是本项目约定（见 SCP_SRC / SSH_KEY）。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CET4 = ROOT / "public" / "data" / "cet4.json"
REVIEW_DEFAULT = Path("missing-words-review.json")
LOCAL_JSONL = Path("missing-words.jsonl")

SCP_SRC = "root@198.44.81.247:/opt/pronunciation-trainer/logs/missing-words.jsonl"
SSH_KEY = Path("~/.ssh/id_muse_suichuan").expanduser()

UA = "EnglishPronunciationTrainer/1.0 (missing-words-review)"
DICT_API = "https://api.dictionaryapi.dev/api/v2/entries/en"
WIKT_API = "https://en.wiktionary.org/api/rest_v1/page/definition"


def http_get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def fetch_from_server(dest: Path) -> None:
    cmd = ["scp", "-P", "22", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"]
    if SSH_KEY.is_file():
        cmd += ["-i", str(SSH_KEY)]
    cmd += [SCP_SRC, str(dest)]
    print("拉取缺词记录：", " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0 or not dest.is_file():
        sys.exit("scp 拉取失败：请确认服务器可达且密钥可用，或手动 scp 后用 --input 指定本地文件")


def load_records(path: Path):
    """聚合 JSONL：{word: {count, foundOnline}}，foundOnline 只要有一次 true 即 true。"""
    agg = {}
    if not path.is_file():
        sys.exit(f"缺词记录文件不存在：{path}（先用 --fetch 从服务器拉取，或用 --input 指定）")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        w = str(rec.get("word", "")).strip().lower()
        if not w:
            continue
        e = agg.setdefault(w, {"count": 0, "foundOnline": False})
        e["count"] += 1
        if rec.get("foundOnline"):
            e["foundOnline"] = True
    return agg


def load_cet4_words(cet4_path):
    entries = json.loads(Path(cet4_path).read_text(encoding="utf-8"))
    return {e["w"] for e in entries if e.get("w")}


def enrich(word: str):
    """在线核查：返回 (ipa, definition, status)。
    status: ok（有音标+释义）/ no-ipa（有释义无音标）/ not-found（都查不到，多为错字）。"""
    ipa = ""
    definition = ""
    try:
        data = http_get_json(f"{DICT_API}/{urllib.request.quote(word)}")
        entry = data[0] if isinstance(data, list) and data else None
        if entry:
            ipa = entry.get("phonetic") or ""
            if not ipa:
                for p in entry.get("phonetics") or []:
                    if p.get("text"):
                        ipa = p["text"]
                        break
            meanings = entry.get("meanings") or []
            if meanings:
                defs = (meanings[0].get("definitions") or [])
                if defs:
                    definition = (defs[0].get("definition") or "").strip()
    except Exception:
        pass
    if definition:
        return ipa, definition, ("ok" if ipa else "no-ipa")
    # Free Dictionary 无释义 -> Wiktionary REST 兜底取释义（音标为空）
    try:
        data = http_get_json(f"{WIKT_API}/{urllib.request.quote(word)}")
        en = data.get("en") or []
        if en:
            defs = (en[0].get("definitions") or [])
            for d in defs:
                raw = re.sub(r"<[^>]+>", "", str(d.get("definition") or "")).strip()
                if raw:
                    return "", raw, "no-ipa"
    except Exception:
        pass
    return "", "", "not-found"


def cmd_review(args) -> None:
    src = Path(args.input) if args.input else LOCAL_JSONL
    if args.fetch:
        fetch_from_server(src)
    agg = load_records(src)
    in_cet4 = load_cet4_words(args.cet4)
    review = []
    for word, e in sorted(agg.items(), key=lambda kv: (-kv[1]["count"], kv[0])):
        if word in in_cet4:
            continue  # 已在词表，无需补
        ipa, definition, status = enrich(word)
        review.append(
            {
                "word": word,
                "count": e["count"],
                "foundOnline": e["foundOnline"],
                "ipa": ipa,
                "definition": definition,
                "status": status,
            }
        )
        print(f"{word}: count={e['count']} foundOnline={e['foundOnline']} status={status}")
        time.sleep(0.2)  # 轻微限速，遵守上游 API 礼仪
    out = Path(args.out)
    out.write_text(json.dumps(review, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    ok = sum(1 for r in review if r["status"] == "ok")
    print(f"\n共 {len(review)} 个待核查词（{ok} 个有音标+释义），已写 {out}。人工删掉不要的行后跑 --apply。")


def cmd_apply(args) -> None:
    review_path = Path(args.apply)
    if not review_path.is_file():
        sys.exit(f"review 文件不存在：{review_path}")
    review = json.loads(review_path.read_text(encoding="utf-8"))
    cet4_path = Path(args.cet4)
    entries = json.loads(cet4_path.read_text(encoding="utf-8"))
    have = {e["w"] for e in entries if e.get("w")}
    added, skipped = [], []
    for r in review:
        w = str(r.get("word", "")).strip().lower()
        if not w or w in have:
            continue
        definition = str(r.get("definition", "")).strip()
        if not definition:
            skipped.append(w)  # 无释义无法合并（多为错字）
            continue
        entries.append({"w": w, "p": str(r.get("ipa", "")).strip(), "d": definition})
        have.add(w)
        added.append(w)
    entries.sort(key=lambda e: e["w"])
    cet4_path.write_text(json.dumps(entries, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"已合并 {len(added)} 个词进 {cet4_path}（词表现 {len(entries)} 词）")
    if added:
        print("新增：", ", ".join(added))
    if skipped:
        print(f"跳过 {len(skipped)} 个无释义的词（无法合并，请人工确认是否为错字）：", ", ".join(skipped))
    print("\n下一步：下载新词音频 -> 构建 -> OTA 发布：")
    print("  python3 scripts/download-audio.py && npm run build && python3 scripts/build-ota.py")


def main() -> None:
    ap = argparse.ArgumentParser(description="缺词上报的打包工具（核查 + 合并）")
    ap.add_argument("--fetch", action="store_true", help="先用 scp 从服务器拉取 missing-words.jsonl")
    ap.add_argument("--input", default="", help="本地缺词记录 JSONL（默认 ./missing-words.jsonl）")
    ap.add_argument("--out", default=str(REVIEW_DEFAULT), help="核查输出 review 文件（默认 missing-words-review.json）")
    ap.add_argument("--cet4", default=str(CET4), help="词表 JSON（默认 public/data/cet4.json，仅测试时改）")
    ap.add_argument("--apply", default="", help="把 review 文件里保留的词合并进词表")
    args = ap.parse_args()
    if args.apply:
        cmd_apply(args)
    else:
        cmd_review(args)


if __name__ == "__main__":
    main()
