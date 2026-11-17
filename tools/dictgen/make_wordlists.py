#!/usr/bin/env python3
"""
下载公开考试词表并归一化为 dictgen 输入（wordlists/*.txt + master.txt）。

版权说明：只提取"单词本身"（考试大纲词目=事实数据），不使用任何来源的
释义/翻译/例句——那些由 generate.py 用 LLM 原创生成，构成自有数据资产。
"""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "wordlists"
QW = "https://raw.githubusercontent.com/RealKai42/qwerty-learner/master/public/dicts"

SOURCES: dict[str, list[str]] = {
    "cet4": [f"{QW}/CET4_T.json"],
    "cet6": [f"{QW}/CET6_T.json"],
    "ky": [f"{QW}/KaoYan_3_T.json"],
    "ielts": [f"{QW}/IELTS_3_T.json"],
    "toefl": [f"{QW}/TOEFL_3_T.json"],
    "gre": [f"{QW}/GRE_3_T.json"],
}

WORD_RE = re.compile(r"^[a-z][a-z'\-]*$")


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def extract_words(raw: bytes) -> list[str]:
    data = json.loads(raw)
    out = []
    for item in data:
        name = (item.get("name") if isinstance(item, dict) else str(item)) or ""
        w = name.strip().lower()
        if WORD_RE.match(w) and 2 <= len(w) <= 24:
            out.append(w)
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    tags_by_word: dict[str, set[str]] = {}
    for tag, urls in SOURCES.items():
        words: set[str] = set()
        for url in urls:
            try:
                words.update(extract_words(fetch(url)))
            except Exception as e:  # noqa: BLE001
                print(f"!! {tag} {url}: {e}")
        (OUT / f"{tag}.txt").write_text(
            "\n".join(f"{w}\t{tag}" for w in sorted(words)) + "\n", encoding="utf-8")
        print(f"{tag}: {len(words)}")
        for w in words:
            tags_by_word.setdefault(w, set()).add(tag)

    order = ["cet4", "cet6", "ky", "ielts", "toefl", "gre"]
    lines = [
        f"{w}\t{','.join(t for t in order if t in tags)}"
        for w, tags in sorted(tags_by_word.items())
    ]
    (OUT / "master.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"master: {len(lines)} unique words -> wordlists/master.txt")


if __name__ == "__main__":
    main()
