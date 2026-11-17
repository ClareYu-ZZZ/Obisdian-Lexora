/**
 * 在线词典兜底：本地词库查不到的词（如欧路导入的生僻词）用
 * dictionaryapi.dev 拉英文释义 + 例句，回填进词卡快照。
 * 个人使用的免费开放 API；商用版替换为授权词典源（见设计文档 §8 红线）。
 */

import { requestUrl } from 'obsidian';
import type { WordEntry } from '@elp/core';

interface ApiDef { definition?: string; example?: string }
interface ApiMeaning { partOfSpeech?: string; definitions?: ApiDef[] }
interface ApiEntry { phonetic?: string; phonetics?: Array<{ text?: string }>; meanings?: ApiMeaning[] }

const POS_ABBR: Record<string, string> = {
  noun: 'n', verb: 'v', adjective: 'adj', adverb: 'adv',
  pronoun: 'pron', preposition: 'prep', conjunction: 'conj',
  interjection: 'int', exclamation: 'int',
};

/** 有道简明释义（中文）："n. 苹果；苹果公司" → 按词性拆条。个人使用源，商用版换授权词典。 */
async function fromYoudaoSuggest(word: string): Promise<string[] | null> {
  try {
    const res = await requestUrl({
      url: `https://dict.youdao.com/suggest?num=1&doctype=json&q=${encodeURIComponent(word)}`,
      throw: false,
    });
    if (res.status !== 200) return null;
    const data = res.json as { data?: { entries?: Array<{ entry?: string; explain?: string }> } };
    const hit = data.data?.entries?.find((e) => e.entry?.toLowerCase() === word.toLowerCase())
      ?? data.data?.entries?.[0];
    const explain = hit?.explain?.trim();
    if (!explain) return null;
    // 在词性标记（n./v./adj.…）前断开成多条
    const senses = explain
      .split(/[;；]\s*(?=[a-z]{1,6}\.\s*)/i)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 4);
    return senses.length > 0 ? senses : null;
  } catch {
    return null;
  }
}

/** 英英词典：音标 + 英文释义 + 例句（中文拿不到时的释义兜底）。 */
async function fromFreeDict(word: string): Promise<{ phonetic: string; senses: string[]; examples: string[] } | null> {
  try {
    const res = await requestUrl({
      url: `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      throw: false,
    });
    if (res.status !== 200) return null;
    const first = (res.json as ApiEntry[])?.[0];
    if (!first) return null;
    const senses: string[] = [];
    const examples: string[] = [];
    for (const m of first.meanings ?? []) {
      const pos = POS_ABBR[m.partOfSpeech ?? ''] ?? m.partOfSpeech ?? '';
      for (const d of (m.definitions ?? []).slice(0, 2)) {
        if (d.definition && senses.length < 4) senses.push(pos ? `${pos}. ${d.definition}` : d.definition);
        if (d.example && examples.length < 2) examples.push(d.example);
      }
    }
    const phon = (first.phonetics ?? []).map((p) => p.text).find(Boolean) ?? first.phonetic ?? '';
    return { phonetic: phon.replace(/^\/|\/$/g, ''), senses, examples };
  } catch {
    return null;
  }
}

/** 在线补全：中文释义（有道）优先，英英补音标/例句；中文拿不到才用英文释义。 */
export async function lookupOnline(word: string): Promise<WordEntry | null> {
  const [zh, en] = await Promise.all([fromYoudaoSuggest(word), fromFreeDict(word)]);
  const senses = zh ?? en?.senses ?? [];
  if (senses.length === 0) return null;
  return {
    lemma: word,
    phoneticUS: en?.phonetic ?? '',
    senses,
    tags: [],
    variants: [],
    examples: (en?.examples ?? []).map((e) => ({ en: e })),
    definitionEn: zh && en?.senses.length ? en.senses.slice(0, 1) : undefined,
  };
}
