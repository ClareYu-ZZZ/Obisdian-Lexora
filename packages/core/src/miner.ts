/**
 * Word mining + hard-sentence picking, ported from the validated
 * mine_vtt.py heuristics.
 */

import { tokenize } from './matcher';
import type { LessonSegment } from './subtitles';
import type { WordEntry } from './types';

export interface MineOptions {
  /** Exam tags to keep (empty = frequency only). */
  levels: string[];
  maxWords: number;
  maxSentences: number;
  /** Words ranked beyond this are kept even without a level tag. */
  minRank: number;
}

export const DEFAULT_MINE_OPTIONS: MineOptions = {
  levels: ['cet6', 'ky', 'toefl', 'ielts', 'gre'],
  maxWords: 30,
  maxSentences: 12,
  minRank: 6000,
};

export interface PickedWord {
  entry: WordEntry;
  /** First segment the word appears in. */
  segIdx: number;
  count: number;
  score: number;
}

export interface HardSentencePick {
  segIdx: number;
  score: number;
}

export interface MinedLesson {
  words: PickedWord[];
  hard: HardSentencePick[];
}

const STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'was', 'were',
  'are', 'you', 'your', 'they', 'their', 'them', 'but', 'not', 'for', 'what', 'when',
  'where', 'who', 'how', 'why', 'all', 'can', 'could', 'would', 'should', 'will',
  'just', 'like', 'get', 'got', 'going', 'about', 'out', 'one', 'two', 'there',
  'been', 'being', 'into', 'over', 'than', 'then', 'them', 'these', 'those', 'some',
  'more', 'most', 'very', 'really', 'because', 'okay', 'yeah', 'know', 'think',
]);

const CLAUSE_MARKERS = /\b(which|that|who|whom|whose|where|when|while|although|though|because|since|unless|whereas|despite|however|moreover|therefore|if)\b/gi;

interface DictLike {
  lookup(surface: string): Promise<WordEntry | null>;
}

/** Proper-noun heuristic: capitalized but never seen sentence-initial lowercase. */
function isLikelyProperNoun(surface: string, sentenceStart: boolean): boolean {
  return /^[A-Z]/.test(surface) && !sentenceStart;
}

export async function mineLesson(
  segments: LessonSegment[],
  dict: DictLike,
  opts: MineOptions,
  isExcluded: (lemma: string) => boolean,
): Promise<MinedLesson> {
  // ---- collect candidate surfaces ----
  interface Cand { surfaces: Set<string>; segIdx: number; count: number; properOnly: boolean }
  const cands = new Map<string, Cand>(); // keyed by lowercase surface
  segments.forEach((seg, segIdx) => {
    const tokens = tokenize(seg.text);
    tokens.forEach((t, ti) => {
      if (t.text.length < 3) return;
      const lower = t.text.toLowerCase();
      if (STOP.has(lower)) return;
      const proper = isLikelyProperNoun(t.text, ti === 0);
      let c = cands.get(lower);
      if (!c) {
        c = { surfaces: new Set(), segIdx, count: 0, properOnly: true };
        cands.set(lower, c);
      }
      c.surfaces.add(t.text);
      c.count++;
      if (!proper) c.properOnly = false;
    });
  });

  // ---- look up + score ----
  const byLemma = new Map<string, PickedWord>();
  for (const [surface, cand] of cands) {
    if (cand.properOnly) continue; // names / places
    const entry = await dict.lookup(surface);
    if (!entry || entry.senses.length === 0) continue;
    const lemma = entry.lemma;
    if (lemma.length < 3 || STOP.has(lemma) || isExcluded(lemma)) continue;

    const levelHits = opts.levels.filter((l) => entry.tags.includes(l)).length;
    const rank = entry.freqRank ?? 0;
    const rareEnough = rank === 0 ? false : rank >= opts.minRank;
    if (opts.levels.length > 0 && levelHits === 0 && !rareEnough) continue;
    if (opts.levels.length === 0 && !rareEnough) continue;

    const score =
      levelHits * 3 +
      Math.min(rank, 30000) / 3000 +
      Math.min(cand.count, 5) * 0.5;

    const existing = byLemma.get(lemma);
    if (existing) {
      existing.count += cand.count;
      existing.segIdx = Math.min(existing.segIdx, cand.segIdx);
      existing.score = Math.max(existing.score, score);
    } else {
      byLemma.set(lemma, { entry, segIdx: cand.segIdx, count: cand.count, score });
    }
  }

  const words = [...byLemma.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxWords);

  // ---- hard sentences ----
  const pickedLemmas = new Set(words.map((w) => w.entry.lemma));
  const pickedSurfaces = new Set<string>();
  for (const w of words) {
    pickedSurfaces.add(w.entry.lemma);
    for (const v of w.entry.variants) pickedSurfaces.add(v);
  }
  const hardAll: HardSentencePick[] = [];
  segments.forEach((seg, segIdx) => {
    const tokens = tokenize(seg.text);
    const len = tokens.length;
    if (len < 12 || len > 60) return;
    const clauses = (seg.text.match(CLAUSE_MARKERS) ?? []).length;
    const commas = (seg.text.match(/,/g) ?? []).length;
    const newWords = tokens.filter((t) => pickedSurfaces.has(t.text.toLowerCase())).length;
    const score = len * 0.3 + clauses * 2 + Math.min(commas, 4) * 0.8 + newWords * 1.5;
    hardAll.push({ segIdx, score });
  });
  const hard = hardAll
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxSentences)
    .sort((a, b) => a.segIdx - b.segIdx);

  void pickedLemmas;
  return { words, hard };
}
