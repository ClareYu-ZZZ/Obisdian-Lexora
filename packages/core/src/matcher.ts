/**
 * Highlight matcher: maps every surface form of every collected word to its
 * card, and tokenizes text for scanning. Pure functions — used by both the
 * CM6 view-plugin and the reading-view post-processor.
 */

import type { WordBook, WordCard } from './types';

export interface MatchInfo {
  /** 所属词本标识色。 */
  color?: string;
  lemma: string;
  bookId: string;
  bookName: string;
  cardId: string;
  status: WordCard['status'];
}

export class HighlightIndex {
  private map = new Map<string, MatchInfo>();
  /** Bumped whenever the index is rebuilt; views compare to refresh. */
  version = 0;

  rebuild(books: WordBook[], opts: { includeMastered: boolean }): void {
    this.map.clear();
    for (const book of books) {
      for (const card of book.cards) {
        if (!opts.includeMastered && card.status === 'mastered') continue;
        const info: MatchInfo = {
          lemma: card.lemma,
          color: book.color,
          bookId: book.id,
          bookName: book.name,
          cardId: card.id,
          status: card.status,
        };
        this.map.set(card.lemma, info);
        for (const v of card.variants) if (!this.map.has(v)) this.map.set(v, info);
      }
    }
    this.version++;
  }

  get size(): number {
    return this.map.size;
  }

  match(surface: string): MatchInfo | null {
    return this.map.get(surface.toLowerCase()) ?? null;
  }
}

export interface Token {
  text: string;
  start: number;
  end: number;
}

const WORD_RE = /[A-Za-z][A-Za-z''-]*/g;

/** Tokenize English words in a text chunk with offsets. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Find all matches of the index in a text chunk. */
export function scan(text: string, index: HighlightIndex): Array<Token & { info: MatchInfo }> {
  const hits: Array<Token & { info: MatchInfo }> = [];
  for (const t of tokenize(text)) {
    if (t.text.length < 2) continue;
    const info = index.match(t.text);
    if (info) hits.push({ ...t, info });
  }
  return hits;
}
