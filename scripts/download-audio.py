#!/usr/bin/env python3
"""为 4500 词下载真人语音（打包进 APK 用）。

来源（与网页版相同）：
  1. Wiktionary wikitext 里的 {{audio|en|...}} -> Wikimedia Commons OGG（优先 en-us，其次其它 en 口音）
  2. 失败时兜底 Free Dictionary API 的音频 URL（通常是 dictionaryapi.dev 的 MP3）

输出（默认 public/data/audio/，全部 gitignore，不进 git）：
  <word>.ogg / <word>.mp3   每个词一个音频文件
  manifest.json             {word: filename}，App 用它判断本地是否有真人音频
  report.json               总数 / 有音频数 / 无音频词 / 失败词 / 总字节数

断点续跑：已存在且非空的文件直接跳过；manifest 与旧清单合并（本次处理的词以本次结果为准，
未处理的词保留旧条目），用 --words 子集跑也不会清掉其他词的条目。
限速：默认 10 请求/秒 + 8 并发 + 3 次重试，遵守 Wikimedia API 礼仪（描述性 User-Agent）。

用法：
  python3 scripts/download-audio.py                 # 全量
  python3 scripts/download-audio.py --limit 20       # 只下前 20 个词（测试）
  python3 scripts/download-audio.py --workers 4 --rate 5
  SKIP_AUDIO=1 bash scripts/prepare-capacitor.sh     # 跳过音频（快速本地构建）
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = "EnglishPronunciationTrainer/1.0 (offline-audio-download; https://github.com/zuna2026x7/english-pronunciation-trainer)"
WIKTIONARY_API = "https://en.wiktionary.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
DICT_API = "https://api.dictionaryapi.dev/api/v2/entries/en"

AUDIO_RE = re.compile(r"\{\{audio\|en\|([^|}]+?\.(?:ogg|mp3|wav))", re.I)


class RateLimiter:
    """简单令牌桶：每秒最多 rate 个请求。"""

    def __init__(self, rate: float):
        self.interval = 1.0 / rate
        self.lock = threading.Lock()
        self.next_at = 0.0

    def acquire(self):
        with self.lock:
            now = time.monotonic()
            if now < self.next_at:
                time.sleep(self.next_at - now)
            self.next_at = max(time.monotonic(), self.next_at) + self.interval


def http_get_json(url: str, limiter: RateLimiter, timeout: int = 30):
    last_err = None
    for attempt in range(3):
        try:
            limiter.acquire()
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001 - 重试所有错误
            last_err = e
            time.sleep(1 * (2**attempt))
    raise RuntimeError(f"GET {url} 失败（重试 3 次）: {last_err}")


def http_download(url: str, dest_tmp: str, limiter: RateLimiter, timeout: int = 60) -> int:
    last_err = None
    for attempt in range(3):
        try:
            limiter.acquire()
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                total = 0
                with open(dest_tmp, "wb") as f:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        f.write(chunk)
                        total += len(chunk)
                if total == 0:
                    raise RuntimeError("下载到 0 字节")
                return total
        except Exception as e:  # noqa: BLE001 - 重试所有错误
            last_err = e
            try:
                os.remove(dest_tmp)
            except OSError:
                pass
            time.sleep(1 * (2**attempt))
    raise RuntimeError(f"下载 {url} 失败（重试 3 次）: {last_err}")


def pick_audio_filename(wikitext: str):
    """从 wikitext 里选一个最合适的音频文件名：优先 en-us，其次其它 en 口音，同分优先 .ogg。"""
    names = AUDIO_RE.findall(wikitext)
    if not names:
        return None

    def score(name: str):
        low = name.lower()
        accent = 3 if "us" in low else (2 if any(x in low for x in ("uk", "au", "ca", "nz", "ie", "za")) else 1)
        fmt = 1 if low.endswith(".ogg") else 0
        return (accent, fmt)

    # 同分取第一次出现（主录音通常在前）
    best = names[0]
    best_score = score(best)
    for n in names[1:]:
        s = score(n)
        if s > best_score:
            best, best_score = n, s
    return best.strip()


def commons_direct_url(filename: str, limiter: RateLimiter):
    from urllib.parse import quote

    url = f"{COMMONS_API}?action=query&prop=imageinfo&iiprop=url&format=json&titles={quote('File:' + filename)}"
    data = http_get_json(url, limiter)
    pages = (data.get("query") or {}).get("pages") or {}
    for page in pages.values():
        info = (page.get("imageinfo") or [{}])[0]
        raw = info.get("url")
        if raw:
            return raw.split("?")[0]
    return None


def dict_api_audio(word: str, limiter: RateLimiter):
    """Free Dictionary API 兜底：返回音频 URL（优先 us），没有返回 None。"""
    from urllib.parse import quote

    try:
        data = http_get_json(f"{DICT_API}/{quote(word)}", limiter)
    except Exception:  # noqa: BLE001 - 404/失败都走无音频
        return None
    entry = data[0] if isinstance(data, list) and data else None
    if not entry:
        return None
    audios = [p.get("audio") for p in (entry.get("phonetics") or []) if p.get("audio")]
    if not audios:
        return None
    for a in audios:
        if "us" in a.lower():
            return a
    return audios[0]


def download_one(word: str, out_dir: str, limiter: RateLimiter):
    """返回 (word, filename | None, reason)。filename 为 None 表示无音频/失败。"""
    from urllib.parse import quote

    # 1. Wiktionary
    try:
        wt_url = (
            f"{WIKTIONARY_API}?action=parse&page={quote(word)}"
            f"&prop=wikitext&format=json"
        )
        data = http_get_json(wt_url, limiter)
        wikitext = ((data.get("parse") or {}).get("wikitext") or {}).get("*", "")
        filename = pick_audio_filename(wikitext) if wikitext else None
        if filename:
            direct = commons_direct_url(filename, limiter)
            if direct:
                ext = filename.rsplit(".", 1)[-1].lower()
                if ext not in ("ogg", "mp3", "wav"):
                    ext = "ogg"
                dest_name = f"{word}.{ext}"
                dest = os.path.join(out_dir, dest_name)
                tmp = dest + ".tmp"
                http_download(direct, tmp, limiter)
                os.replace(tmp, dest)
                return word, dest_name, "wiktionary"
    except Exception as e:  # noqa: BLE001 - 失败则走词典兜底
        last_wiki_err = str(e)
    else:
        last_wiki_err = "wikitext 无音频"

    # 2. Free Dictionary API 兜底
    try:
        audio_url = dict_api_audio(word, limiter)
        if audio_url:
            ext = "mp3" if ".mp3" in audio_url.lower() else "ogg"
            dest_name = f"{word}.{ext}"
            dest = os.path.join(out_dir, dest_name)
            tmp = dest + ".tmp"
            http_download(audio_url, tmp, limiter)
            os.replace(tmp, dest)
            return word, dest_name, "dictionaryapi"
    except Exception as e:  # noqa: BLE001 - 失败则记无音频
        return word, None, f"词典兜底失败: {e}"

    return word, None, f"无音频（{last_wiki_err}）"


def main() -> int:
    ap = argparse.ArgumentParser(description="下载 4500 词真人语音")
    ap.add_argument("--words", default="public/data/cet4.json", help="词表 JSON")
    ap.add_argument("--out", default="public/data/audio", help="音频输出目录")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个词（测试用，0=全部）")
    ap.add_argument("--workers", type=int, default=8, help="并发数")
    ap.add_argument("--rate", type=float, default=10.0, help="每秒最多请求数")
    args = ap.parse_args()

    with open(args.words, encoding="utf-8") as f:
        entries = json.load(f)
    words = [e["w"] for e in entries if e.get("w")]
    if args.limit:
        words = words[: args.limit]

    os.makedirs(args.out, exist_ok=True)
    limiter = RateLimiter(args.rate)

    # 断点续跑：按磁盘实际文件重建已下载集合
    manifest = {}
    skipped = 0
    for w in words:
        for ext in ("ogg", "mp3", "wav"):
            p = os.path.join(args.out, f"{w}.{ext}")
            if os.path.isfile(p) and os.path.getsize(p) > 0:
                manifest[w] = f"{w}.{ext}"
                skipped += 1
                break

    todo = [w for w in words if w not in manifest]
    print(f"词表 {len(words)} 个，已下载 {skipped} 个，待下载 {len(todo)} 个 -> {args.out}")
    sys.stdout.flush()

    # 清单合并：保留旧清单里未在本轮处理的词的条目。
    # 否则用 --words 子集跑时，写回的清单会丢掉其他词的条目（2026-10-18 实测：只跑 reservoir
    # 一个词，清单被重写成 1 条；已用 git 恢复并追加 reservoir 条目）。
    try:
        with open(os.path.join(args.out, "manifest.json"), encoding="utf-8") as f:
            old_manifest = json.load(f)
    except Exception:
        old_manifest = {}
    if isinstance(old_manifest, dict):
        for w, fn in old_manifest.items():
            if w not in manifest and isinstance(fn, str):
                manifest[w] = fn

    results = {}
    no_audio = []
    failed = []
    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(download_one, w, args.out, limiter): w for w in todo}
        for fut in as_completed(futures):
            w = futures[fut]
            done += 1
            try:
                _, filename, reason = fut.result()
            except Exception as e:  # noqa: BLE001 - 单词失败不中断整体
                failed.append({"word": w, "reason": str(e)})
                print(f"[{done}/{len(todo)}] {w}: 异常 {e}")
            else:
                if filename:
                    results[w] = filename
                    print(f"[{done}/{len(todo)}] {w}: OK {filename} ({reason})")
                else:
                    no_audio.append({"word": w, "reason": reason})
                    print(f"[{done}/{len(todo)}] {w}: 无音频 ({reason})")
            if done % 100 == 0:
                # 每 100 个保存一次进度，防中断丢失 manifest
                tmp_manifest = dict(manifest)
                tmp_manifest.update(results)
                with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
                    json.dump(tmp_manifest, f, ensure_ascii=False, sort_keys=True)
                print(f"  ...已保存进度 manifest（{len(tmp_manifest)} 个）")
            sys.stdout.flush()

    manifest.update(results)
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, sort_keys=True)

    total_bytes = 0
    for fn in set(manifest.values()):
        try:
            total_bytes += os.path.getsize(os.path.join(args.out, fn))
        except OSError:
            pass
    report = {
        "total_words": len(words),
        "with_audio": len(manifest),
        "skipped_existing": skipped,
        "newly_downloaded": len(results),
        "no_audio": no_audio,
        "failed": failed,
        "total_bytes": total_bytes,
        "elapsed_seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(
        f"完成：{len(words)} 词，有音频 {len(manifest)} 个 "
        f"（已有 {skipped} + 新下 {len(results)}），无音频 {len(no_audio)} 个，"
        f"失败 {len(failed)} 个，总 {total_bytes / 1048576:.1f} MB，用时 {report['elapsed_seconds']}s"
    )
    if no_audio:
        print("无音频词：" + ", ".join(x["word"] for x in no_audio[:50]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
