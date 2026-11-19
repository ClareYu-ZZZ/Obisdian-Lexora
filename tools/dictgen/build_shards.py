#!/usr/bin/env python3
"""
校验 raw/*.json 并构建插件可直接使用的词库分片（dict-cache 格式）。

  python build_shards.py                 # raw/ -> out/dict-cache/
  python build_shards.py --check-only    # 只校验

产物与 @elp/core EcdictDictionary 的分片格式完全兼容：
  <letter>.json: { word: [phonetic, translation, definition, tag, frq, exchange] }
把 out/dict-cache/ 覆盖到 vault 的 English/dict-cache/ 即为自建词库。
音标：有 cmudict 包则从 CMUdict 生成（BSD，商用友好）；词频：有 wordfreq 则估算排名。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

RAW = Path(__file__).parent / "raw"
OUT = Path(__file__).parent / "out" / "dict-cache"
SHARD_VERSION = 1

ARPA2IPA = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ", "B": "b",
    "CH": "tʃ", "D": "d", "DH": "ð", "EH": "e", "ER": "ɝ", "EY": "eɪ", "F": "f",
    "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "i", "JH": "dʒ", "K": "k", "L": "l",
    "M": "m", "N": "n", "NG": "ŋ", "OW": "oʊ", "OY": "ɔɪ", "P": "p", "R": "r",
    "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "UH": "ʊ", "UW": "u", "V": "v",
    "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}


def load_cmudict():
    try:
        import cmudict
        return cmudict.dict()
    except ImportError:
        return None


def ipa_of(word: str, cmu) -> str:
    if not cmu:
        return ""
    prons = cmu.get(word.lower())
    if not prons:
        return ""
    out = []
    for ph in prons[0]:
        stress = "ˈ" if ph.endswith("1") else ("ˌ" if ph.endswith("2") else "")
        base = ph.rstrip("012")
        out.append(stress + ARPA2IPA.get(base, base.lower()))
    return "".join(out)


def rank_of(word: str) -> int:
    try:
        from wordfreq import zipf_frequency
        z = zipf_frequency(word, "en")
        if z <= 0:
            return 50000
        return max(1, int(10 ** (7.3 - z)))  # 粗略：zipf 5≈200, 4≈2000, 3≈20000
    except ImportError:
        return 0


def word_in_example(lemma: str, en: str) -> bool:
    """屈折容忍的包含检查：deny→denied、ally→allies、run→running 都算命中。"""
    lem = lemma.lower()
    stems = {lem}
    if lem.endswith("y"):
        stems.add(lem[:-1])            # deny → deni(ed), ally → alli(es)
    if lem.endswith("e"):
        stems.add(lem[:-1])            # pine → pin(ing)
    if len(lem) >= 3:
        stems.add(lem[: max(4, len(lem) - 2)])
    tokens = re.findall(r"[a-z'\-]+", en.lower())
    if len(lem) < 3:
        return lem in tokens
    return any(t.startswith(st) for t in tokens for st in stems if len(st) >= 3)


def clean_entry(entry: dict, errors: list[str], regen: set[str]) -> dict | None:
    """清洗词条：剔除坏 sense/坏例句；清洗后不完整 → 进重生成名单。"""
    lemma = entry.get("lemma", "")
    if not lemma or len(lemma) < 2:
        errors.append(f"bad lemma: {str(entry)[:60]}")
        return None
    senses = [s for s in entry.get("senses", [])
              if isinstance(s, dict) and s.get("pos") and s.get("zh")]
    examples = []
    for ex in entry.get("examples", []):
        en = (ex or {}).get("en", "").strip()
        if not en:
            continue
        if word_in_example(lemma, en):
            examples.append(ex)
        else:
            errors.append(f"{lemma}: 例句不含目标词，已剔除 → {en[:50]}")
    entry = {**entry, "senses": senses, "examples": examples}
    if not senses:
        errors.append(f"{lemma}: 无有效释义 → 重生成")
        regen.add(lemma)
        return None
    if not examples:
        errors.append(f"{lemma}: 无有效例句 → 重生成")
        regen.add(lemma)
        return None
    return entry


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args()

    entries: dict[str, dict] = {}
    errors: list[str] = []
    regen: set[str] = set()
    for f in sorted(RAW.glob("*.json")):
        for e in json.loads(f.read_text(encoding="utf-8")):
            cleaned = clean_entry(e, errors, regen)
            if cleaned:
                entries[cleaned["lemma"].lower()] = cleaned

    print(f"valid entries: {len(entries)}, warnings: {len(errors)}, need regen: {len(regen)}")
    for err in errors[:20]:
        print("  !", err)
    if args.check_only:
        sys.exit(1 if errors else 0)
    if not entries:
        sys.exit("没有可用词条")

    cmu = load_cmudict()
    shards: dict[str, dict] = {}
    for lemma, e in entries.items():
        key = lemma[0] if lemma[0].isalpha() else "_"
        translation = "\\n".join(f"{s.get('pos', '')} {s.get('zh', '')}".strip() for s in e["senses"])
        # 例句打包进 definition 字段后段？保持兼容：definition 放英文释义；例句进 translation 之后由插件扩展版 schema 消化。
        definition = e.get("definitionEn", "")
        shards.setdefault(key, {})[lemma] = [
            e.get("phoneticUS") or ipa_of(lemma, cmu),
            translation,
            definition,
            " ".join(e.get("tags", [])),
            rank_of(lemma),
            "",
        ]

    OUT.mkdir(parents=True, exist_ok=True)
    for key, shard in shards.items():
        (OUT / f"{key}.json").write_text(json.dumps(shard, ensure_ascii=False), encoding="utf-8")
    (OUT / "meta.json").write_text(json.dumps({
        "version": SHARD_VERSION,
        "entries": len(entries),
        "builtAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "source": "lexora-dictgen",
    }), encoding="utf-8")
    # 例句单独出一份，供后续插件版本消费（P4：卡片例句库）
    examples = {l: e.get("examples", []) for l, e in entries.items()}
    (OUT / "examples.json").write_text(json.dumps(examples, ensure_ascii=False), encoding="utf-8")
    if regen:
        master_tags: dict[str, str] = {}
        master = Path(__file__).parent / "wordlists" / "master.txt"
        if master.exists():
            for line in master.read_text(encoding="utf-8").splitlines():
                if "\t" in line:
                    w, t = line.split("\t", 1)
                    master_tags[w.strip()] = t.strip()
        (OUT.parent / "regen.txt").write_text(
            "\n".join(f"{w}\t{master_tags.get(w, '')}".rstrip()
                       for w in sorted(regen)) + "\n", encoding="utf-8")
        print(f"\u9700\u91cd\u751f\u6210 {len(regen)} \u8bcd -> out/regen.txt")
    print(f"shards -> {OUT}（{len(shards)} 片，含 examples.json）")


if __name__ == "__main__":
    main()
