#!/usr/bin/env python3
"""
LLM 批量生成词条 → raw/batch_*.json

用法：
  OPENAI_API_KEY=sk-xxx python generate.py wordlists/cet6.txt --model gpt-4o-mini
  python generate.py wordlists/demo.txt --demo          # 无网络演示，验证管线

OPENAI_BASE_URL 可指向任何 OpenAI 兼容端点（自托管/国内代理均可）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from prompts import SYSTEM, user_prompt

RAW = Path(__file__).parent / "raw"
BATCH = 10

def demo_entry(word: str) -> dict:
    return {
        "lemma": word,
        "senses": [{"pos": "adj.", "zh": f"（演示释义）{word} 的含义"}],
        "definitionEn": f"demo definition of {word}",
        "examples": [
            {"en": f"This is a demo sentence using {word} in context.", "zh": f"这是包含 {word} 的演示例句。"},
        ],
        "collocations": [f"{word} demo"],
    }


def read_wordlist(path: Path) -> list[tuple[str, list[str]]]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        word = parts[0].strip().lower()
        tags = [t.strip() for t in (parts[1].split(",") if len(parts) > 1 else []) if t.strip()]
        out.append((word, tags))
    return out


def call_llm(words: list[str], model: str) -> list[dict]:
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        sys.exit("缺少 OPENAI_API_KEY（或用 --demo 验证管线）")
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user_prompt(words)},
        ],
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
    }).encode()
    req = urllib.request.Request(
        f"{base}/chat/completions", data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        payload = json.load(res)
    content = payload["choices"][0]["message"]["content"]
    return extract_entries(json.loads(content))


def extract_entries(data) -> list[dict]:
    """兼容：裸数组 / {"entries": [...]} / 任意单键包裹 / 以 lemma 为键的对象。"""
    if isinstance(data, list):
        return [e for e in data if isinstance(e, dict) and e.get("lemma")]
    if isinstance(data, dict):
        if isinstance(data.get("entries"), list):
            return extract_entries(data["entries"])
        for v in data.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return extract_entries(v)
        keyed = [
            {**v, "lemma": v.get("lemma", k)}
            for k, v in data.items() if isinstance(v, dict)
        ]
        if keyed:
            return [e for e in keyed if e.get("lemma")]
    return []


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wordlist", type=Path)
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--demo", action="store_true", help="离线演示：生成占位词条验证管线")
    args = ap.parse_args()

    words = read_wordlist(args.wordlist)
    tags_of = dict(words)
    RAW.mkdir(exist_ok=True)

    for i in range(0, len(words), BATCH):
        batch = [w for w, _ in words[i:i + BATCH]]
        out = RAW / f"batch_{args.wordlist.stem}_{i // BATCH:04d}.json"
        if out.exists():
            print(f"skip {out.name}（已存在）")
            continue
        if args.demo:
            entries = [demo_entry(w) for w in batch]
        else:
            entries = []
            for attempt in range(3):
                try:
                    entries = call_llm(batch, args.model)
                    if entries:
                        break
                    print(f"retry {attempt + 1}: 解析出 0 词条")
                except Exception as e:  # noqa: BLE001
                    print(f"retry {attempt + 1}: {e}")
                time.sleep(5 * (attempt + 1))
            if not entries:
                sys.exit(f"批次连续失败，已停止（该批次未落盘，可直接重跑续传）：{batch}")
            missing = set(batch) - {e["lemma"].lower() for e in entries}
            if missing:
                print(f"  ! 本批缺词 {len(missing)}: {sorted(missing)[:5]}…")
        for e in entries:
            e["tags"] = tags_of.get(e.get("lemma", "").lower(), [])
        out.write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {out.name}: {len(entries)} entries")


if __name__ == "__main__":
    main()
