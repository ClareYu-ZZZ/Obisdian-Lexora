/**
 * ECDICT csv adapter.
 *
 * The plugin never ships dictionary data. The user points the plugin at a
 * dictionary file they obtained themselves (P0: ECDICT csv format); a future
 * commercial build swaps in the self-built dictionary with the same interface.
 *
 * Strategy: one-time build of per-letter JSON shards into `dict-cache/`,
 * then lazy shard loading at lookup time. Keeps steady-state memory tiny.
 *
 * ECDICT csv columns:
 * word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
 */

import type { StorageAdapter, WordEntry } from '../types';

/** Compact on-disk entry: [phonetic, translation, definition, tag, frq, exchange] */
type ShardEntry = [string, string, string, string, number, string];
type Shard = Record<string, ShardEntry>;

const SHARD_VERSION = 1;

export function shardKeyFor(word: string): string {
  const c = word.charAt(0).toLowerCase();
  return c >= 'a' && c <= 'z' ? c : '_';
}

/** Streaming-ish CSV parser (handles quoted fields with commas/newlines). */
export function* parseCsvRecords(text: string): Generator<string[]> {
  const n = text.length;
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  // Skip BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') yield record;
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field); yield record; }
}

export interface BuildProgress {
  (done: number, phase: 'parse' | 'write'): void;
}

export interface BuildResult {
  entries: number;
  shards: number;
}

/**
 * Build shards from a raw ECDICT csv string.
 * Multi-word phrases are kept (they power phrase cards later) but stored
 * under the shard of their first character like any other key.
 */
export async function buildDictIndex(
  csvText: string,
  storage: StorageAdapter,
  cacheFolder: string,
  onProgress?: BuildProgress,
): Promise<BuildResult> {
  const shards = new Map<string, Shard>();
  let count = 0;
  let header = true;
  for (const rec of parseCsvRecords(csvText)) {
    if (header) { header = false; if (rec[0]?.toLowerCase() === 'word') continue; }
    const word = (rec[0] ?? '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    const shardKey = shardKeyFor(key);
    let shard = shards.get(shardKey);
    if (!shard) { shard = {}; shards.set(shardKey, shard); }
    shard[key] = [
      rec[1] ?? '',                      // phonetic
      rec[3] ?? '',                      // translation (zh)
      rec[2] ?? '',                      // definition (en)
      rec[7] ?? '',                      // tag
      parseInt(rec[9] ?? '', 10) || 0,   // frq
      rec[10] ?? '',                     // exchange
    ];
    count++;
    if (onProgress && count % 50000 === 0) onProgress(count, 'parse');
  }
  await storage.mkdir(cacheFolder);
  let written = 0;
  for (const [key, shard] of shards) {
    await storage.writeText(`${cacheFolder}/${key}.json`, JSON.stringify(shard));
    written++;
    onProgress?.(written, 'write');
  }
  await storage.writeText(
    `${cacheFolder}/meta.json`,
    JSON.stringify({ version: SHARD_VERSION, entries: count, builtAt: new Date().toISOString() }),
  );
  return { entries: count, shards: shards.size };
}

/** Parse ECDICT exchange field into surface variants (excluding markers 0/1). */
export function parseExchange(exchange: string): { variants: string[]; lemmaOf?: string } {
  const variants: string[] = [];
  let lemmaOf: string | undefined;
  if (!exchange) return { variants };
  for (const part of exchange.split('/')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const kind = part.slice(0, idx);
    const value = part.slice(idx + 1).trim();
    if (!value) continue;
    if (kind === '0') lemmaOf = value.toLowerCase();
    else if (kind === '1') continue;
    else variants.push(value.toLowerCase());
  }
  return { variants: [...new Set(variants)], lemmaOf };
}

function cleanLines(raw: string): string[] {
  return raw
    .replace(/\\r/g, '')
    .split(/\\n|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type ExampleMap = Record<string, Array<{ en: string; zh?: string }>>;

export class EcdictDictionary {
  private shards = new Map<string, Shard | null>();
  private loading = new Map<string, Promise<Shard | null>>();
  private examples: ExampleMap | null | undefined;

  constructor(
    private storage: StorageAdapter,
    private cacheFolder: string,
  ) {}

  async isReady(): Promise<boolean> {
    return this.storage.exists(`${this.cacheFolder}/meta.json`);
  }

  async meta(): Promise<{ entries: number; builtAt: string } | null> {
    const raw = await this.storage.readText(`${this.cacheFolder}/meta.json`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  invalidate(): void {
    this.shards.clear();
    this.loading.clear();
    this.examples = undefined;
  }

  /** 自建词库附带的例句库（dict-cache/examples.json），没有则为 null。 */
  private async examplesFor(lemma: string): Promise<Array<{ en: string; zh?: string }> | undefined> {
    if (this.examples === undefined) {
      const raw = await this.storage.readText(`${this.cacheFolder}/examples.json`);
      if (raw) {
        try { this.examples = JSON.parse(raw) as ExampleMap; }
        catch { this.examples = null; }
      } else this.examples = null;
    }
    return this.examples?.[lemma] ?? undefined;
  }

  private async shard(key: string): Promise<Shard | null> {
    if (this.shards.has(key)) return this.shards.get(key) ?? null;
    let p = this.loading.get(key);
    if (!p) {
      p = (async () => {
        const raw = await this.storage.readText(`${this.cacheFolder}/${key}.json`);
        const shard: Shard | null = raw ? (JSON.parse(raw) as Shard) : null;
        this.shards.set(key, shard);
        this.loading.delete(key);
        return shard;
      })();
      this.loading.set(key, p);
    }
    return p;
  }

  private async rawLookup(key: string): Promise<ShardEntry | null> {
    const shard = await this.shard(shardKeyFor(key));
    return shard?.[key] ?? null;
  }

  private toEntry(lemma: string, e: ShardEntry): WordEntry {
    const { variants } = parseExchange(e[5]);
    return {
      lemma,
      phoneticUS: e[0] ? `/${e[0]}/` : '',
      senses: cleanLines(e[1]),
      definitionEn: cleanLines(e[2]),
      tags: e[3] ? e[3].split(/\s+/).filter(Boolean) : [],
      freqRank: e[4] || undefined,
      variants,
    };
  }

  /**
   * 词汇量测试抽样：按词频区间分层，每层随机抽 perBand 个单词。
   * 随机遍历分片直到每层配齐，对大词库只读部分分片。
   */
  async sampleByBand(
    bands: Array<[number, number]>, perBand: number,
  ): Promise<SampledWord[]> {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    for (let i = letters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    const buckets: SampledWord[][] = bands.map(() => []);
    const need = () => buckets.some((b) => b.length < perBand * 3);
    for (const letter of letters) {
      if (!need()) break;
      const shard = await this.shard(letter);
      if (!shard) continue;
      for (const [word, e] of Object.entries(shard)) {
        const frq = e[4];
        if (!frq || word.includes(' ') || word.length < 3 || !e[1]) continue;
        const band = bands.findIndex(([lo, hi]) => frq >= lo && frq <= hi);
        if (band < 0) continue;
        buckets[band].push({ lemma: word, freqRank: frq, band });
      }
    }
    const out: SampledWord[] = [];
    for (const bucket of buckets) {
      for (let i = bucket.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bucket[i], bucket[j]] = [bucket[j], bucket[i]];
      }
      out.push(...bucket.slice(0, perBand));
    }
    return out;
  }

  /**
   * Look a surface form up, following ECDICT's own lemma pointer (exchange
   * `0:`) and simple suffix rules, so "races" / "raced" / "racing" → "race".
   */
  async lookup(surface: string): Promise<WordEntry | null> {
    const key = surface.trim().toLowerCase();
    if (!key) return null;
    const finish = async (lemma: string, e: ShardEntry): Promise<WordEntry> => {
      const entry = this.toEntry(lemma, e);
      entry.examples = await this.examplesFor(lemma);
      return entry;
    };
    const direct = await this.rawLookup(key);
    if (direct) {
      const { lemmaOf } = parseExchange(direct[5]);
      // Follow pointer when this key is itself an inflected form whose entry
      // is thin (no translation) — otherwise prefer the direct entry.
      if (lemmaOf && lemmaOf !== key && !direct[1]) {
        const base = await this.rawLookup(lemmaOf);
        if (base) return finish(lemmaOf, base);
      }
      return finish(key, direct);
    }
    for (const cand of suffixCandidates(key)) {
      const hit = await this.rawLookup(cand);
      if (hit) return finish(cand, hit);
    }
    return null;
  }
}

export interface SampledWord {
  lemma: string;
  freqRank: number;
  /** index into the bands array passed to sampleByBand */
  band: number;
}

/** Rule-based lemma candidates for unknown surfaces. Ordered by likelihood. */
export function suffixCandidates(word: string): string[] {
  const out: string[] = [];
  const push = (w: string) => { if (w.length >= 2 && !out.includes(w)) out.push(w); };
  if (word.endsWith("'s")) push(word.slice(0, -2));
  if (word.endsWith('ies')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('es')) push(word.slice(0, -2));
  if (word.endsWith('s')) push(word.slice(0, -1));
  if (word.endsWith('ied')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('ed')) { push(word.slice(0, -2)); push(word.slice(0, -1)); }
  if (word.endsWith('ing')) {
    push(word.slice(0, -3));
    push(word.slice(0, -3) + 'e');
    const stem = word.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) push(stem.slice(0, -1));
  }
  if (word.endsWith('er')) { push(word.slice(0, -2)); push(word.slice(0, -1)); }
  if (word.endsWith('est')) { push(word.slice(0, -3)); push(word.slice(0, -2)); }
  return out;
}
