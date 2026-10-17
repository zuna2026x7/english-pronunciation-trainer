#!/usr/bin/env python3
"""Build src/data/cet4.json from ECDICT (MIT licensed).

Source: https://github.com/skywind3000/ECDICT (MIT License)
  - ECDICT is an open English-Chinese dictionary database.
  - We use only entries tagged `cet4`, keeping: word, phonetic, translation.
  - Words themselves are facts; phonetics/translations come from the MIT-licensed ECDICT.
  - ECDICT's `cet4` tag has ~3,850 headwords; the commonly cited "4500" counts
    inflected/derived forms. To reach 4,500 entries and cover everyday words
    too basic for CET-4 (e.g. hello, chair, world — tagged zk/gk, not cet4),
    the pack is topped up with the most frequent non-CET-4 words by BNC rank
    (ECDICT `bnc` field, lower = more frequent), same MIT source.

ECDICT phonetic quirks normalized to standard IPA (so the app's IPA
tokenizer/scorer, which expects Free Dictionary / Wiktionary style IPA, works):
  - 'ә' (U+04D9, Cyrillic schwa) -> 'ə' (U+0259, Latin schwa)
  - 'є' (Cyrillic ie, ECDICT's /e/ in the /eə/ diphthong) -> 'e'
  - '^' (ECDICT's /ʌ/) -> 'ʌ'
  - "'" (primary stress) -> 'ˈ'
  - ':' (length) -> 'ː'
  - ',' / '.' inside a phonetic = secondary stress -> 'ˌ'
    (a separator followed by whitespace, e.g. ", -dәkt" or ". 'preiә",
    starts a second pronunciation variant -> keep only the first variant)
  - '(r)' etc: parens stripped, contents kept
  - '\\' glitch chars removed

Translation cleanup: literal "\\n" in the CSV -> "; ".

Usage:
  python3 scripts/build-cet4.py [--csv path/to/ecdict.csv] [--out src/data/cet4.json]
If --csv is omitted, ECDICT is downloaded from GitHub (raw) to a temp file.
"""
import argparse
import csv
import json
import re
import sys
import urllib.request
from pathlib import Path

ECDICT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"

# Only words the UI can look up: letters, apostrophe, hyphen, space.
WORD_RE = re.compile(r"^[a-z][a-z' -]*$")


def normalize_phonetic(raw: str) -> str:
    p = (raw or "").strip()
    if not p:
        return ""
    # Keep only the first pronunciation variant: a separator (',' '.' ';')
    # followed by whitespace starts a new variant (e.g. "kɔndʌkt, -dәkt",
    # "prєә. 'preiә", "tiә. tєә"). But a comma NOT followed by
    # whitespace is secondary stress inside one variant ("senti,mi:tә").
    p = re.split(r"[,. ;]\s+", p, maxsplit=1)[0]
    out = []
    for ch in p:
        if ch == "ә":
            out.append("ə")
        elif ch == "є":
            out.append("e")
        elif ch == "^":
            out.append("ʌ")
        elif ch == "'":
            out.append("ˈ")
        elif ch == ":":
            out.append("ː")
        elif ch in {",", "."}:
            out.append("ˌ")  # secondary stress inside one variant
        elif ch in {"(", ")", "\\", '"'}:
            continue  # strip parens/glitches, keep contents
        else:
            out.append(ch)
    norm = "".join(out).strip()
    if not norm:
        return ""
    return f"/{norm}/"


def clean_translation(raw: str) -> str:
    t = (raw or "").replace("\\n", "; ").replace("\n", "; ")
    t = re.sub(r"\s+", " ", t).strip(" ;")
    return t


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="")
    ap.add_argument("--out", default="public/data/cet4.json")
    args = ap.parse_args()

    csv_path = args.csv
    tmp = None
    if not csv_path:
        import tempfile

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".csv")
        tmp.close()
        print(f"Downloading ECDICT from {ECDICT_URL} ...", file=sys.stderr)
        urllib.request.urlretrieve(ECDICT_URL, tmp.name)
        csv_path = tmp.name

    entries = []
    seen = set()
    skipped_no_phonetic = 0
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        all_rows = list(csv.DictReader(f))
    for row in all_rows:
        if "cet4" not in (row.get("tag") or "").split():
            continue
        word = (row.get("word") or "").strip().lower()
        if not word or word in seen or not WORD_RE.match(word):
            continue
        seen.add(word)
        phonetic = normalize_phonetic(row.get("phonetic") or "")
        if not phonetic:
            skipped_no_phonetic += 1
        translation = clean_translation(row.get("translation") or "")
        if not translation:
            continue
        entries.append({"w": word, "p": phonetic, "d": translation})
    cet4_count = len(entries)

    TARGET = 4500
    # Seed: words the app itself references (default lookup 'hello'), so the
    # first-run offline experience works even if they fall outside the
    # frequency cut below.
    SEED = ["hello"]
    if len(entries) < TARGET:
        by_word = {}
        for row in all_rows:
            w = (row.get("word") or "").strip().lower()
            if w and w not in by_word:
                by_word[w] = row
        for w in SEED:
            if len(entries) >= TARGET or w in seen:
                continue
            row = by_word.get(w)
            if not row or not clean_translation(row.get("translation") or ""):
                continue
            seen.add(w)
            phonetic = normalize_phonetic(row.get("phonetic") or "")
            if not phonetic:
                skipped_no_phonetic += 1
            entries.append(
                {"w": w, "p": phonetic, "d": clean_translation(row.get("translation") or "")}
            )

    # Top up to TARGET with the most frequent everyday words (BNC rank, lower
    # = more frequent) that are NOT tagged cet4. This covers basic words like
    # hello / chair / world that CET-4 itself does not list.
    if len(entries) < TARGET:
        def bnc_rank(row):
            try:
                return int(row.get("bnc") or 0) or 10**9
            except ValueError:
                return 10**9

        def frq_rank(row):
            try:
                return int(row.get("frq") or 0) or 10**9
            except ValueError:
                return 10**9

        candidates = []
        for row in all_rows:
            word = (row.get("word") or "").strip().lower()
            if not word or word in seen or not WORD_RE.match(word):
                continue
            if not clean_translation(row.get("translation") or ""):
                continue
            candidates.append(row)
        candidates.sort(key=lambda r: (bnc_rank(r), frq_rank(r)))
        for row in candidates:
            if len(entries) >= TARGET:
                break
            word = (row.get("word") or "").strip().lower()
            seen.add(word)
            phonetic = normalize_phonetic(row.get("phonetic") or "")
            if not phonetic:
                skipped_no_phonetic += 1
            entries.append(
                {
                    "w": word,
                    "p": phonetic,
                    "d": clean_translation(row.get("translation") or ""),
                }
            )

    entries.sort(key=lambda e: e["w"])
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {len(entries)} entries -> {args.out} "
        f"({out_path.stat().st_size / 1024:.0f} KB), "
        f"CET-4 {cet4_count} + top-frequency top-up {len(entries) - cet4_count}, "
        f"{skipped_no_phonetic} without phonetic (spelling/online fallback applies)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
