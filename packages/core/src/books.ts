/** Word book storage + card lifecycle. All IO through StorageAdapter. */

import { newFsrsState, isDue, rateWith } from './fsrs';
import type {
  BookStats, CardContext, ReviewRating, StorageAdapter, WordBook, WordCard, WordEntry,
} from './types';
import { DEFAULT_REVIEW_CONFIG } from './types';

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 词本自动配色盘（按创建顺序分配，不开放自定义）。 */
export const BOOK_PALETTE = [
  '#4ade80', '#60a5fa', '#f59e0b', '#f472b6',
  '#a78bfa', '#fb7185', '#2dd4bf', '#facc15',
];

/** In-place schema migration for books written by older versions. */
function migrateBook(book: WordBook): void {
  book.reviewConfig = { ...DEFAULT_REVIEW_CONFIG, ...(book.reviewConfig ?? {}) };
  if (!book.color) {
    // 旧词本：按 id 稳定取色
    let h = 0;
    for (const ch of book.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    book.color = BOOK_PALETTE[h % BOOK_PALETTE.length];
  }
  for (const card of book.cards) {
    if (!Array.isArray(card.contexts)) card.contexts = [];
    if (card.context) {
      if (card.context.sentence && !card.contexts.some((c) => c.sentence === card.context?.sentence)) {
        card.contexts.push(card.context);
      }
      delete card.context;
    }
  }
}

export interface BookStoreEvents {
  onChange?: () => void;
}

export class BookStore {
  private books = new Map<string, WordBook>();
  /** lemma -> {bookId, cardId} (a lemma lives in at most one book). */
  private lemmaIndex = new Map<string, { bookId: string; cardId: string }>();
  private mastered = new Set<string>();

  constructor(
    private storage: StorageAdapter,
    private folder: string,
    private events: BookStoreEvents = {},
  ) {}

  // ---------- loading & persistence ----------

  async load(): Promise<void> {
    this.books.clear();
    this.lemmaIndex.clear();
    await this.storage.mkdir(this.folder);
    for (const name of await this.storage.list(this.folder)) {
      if (!name.endsWith('.json') || name === 'mastered.json') continue;
      const raw = await this.storage.readText(`${this.folder}/${name}`);
      if (!raw) continue;
      try {
        const book = JSON.parse(raw) as WordBook;
        if (book?.id && Array.isArray(book.cards)) {
          migrateBook(book);
          this.books.set(book.id, book);
        }
      } catch { /* skip corrupt file; never destroy user data */ }
    }
    const rawMastered = await this.storage.readText(`${this.folder}/mastered.json`);
    if (rawMastered) {
      try { this.mastered = new Set(JSON.parse(rawMastered) as string[]); } catch { /* keep empty */ }
    }
    if (this.books.size === 0) {
      await this.createBook('生词本');
    }
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.lemmaIndex.clear();
    for (const book of this.books.values()) {
      for (const card of book.cards) {
        this.lemmaIndex.set(card.lemma, { bookId: book.id, cardId: card.id });
      }
    }
  }

  private async saveBook(book: WordBook): Promise<void> {
    await this.storage.mkdir(this.folder);
    await this.storage.writeText(`${this.folder}/${book.id}.json`, JSON.stringify(book, null, 2));
    this.events.onChange?.();
  }

  private async saveMastered(): Promise<void> {
    await this.storage.writeText(
      `${this.folder}/mastered.json`,
      JSON.stringify([...this.mastered].sort(), null, 2),
    );
    this.events.onChange?.();
  }

  // ---------- books ----------

  listBooks(): WordBook[] {
    return [...this.books.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getBook(id: string): WordBook | undefined {
    return this.books.get(id);
  }

  async createBook(name: string, icon?: string): Promise<WordBook> {
    // 选当前用得最少的调色盘颜色
    const used = new Map<string, number>();
    for (const b of this.books.values()) used.set(b.color ?? '', (used.get(b.color ?? '') ?? 0) + 1);
    const color = [...BOOK_PALETTE].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0];
    const book: WordBook = {
      id: makeId('book'),
      name,
      icon,
      color,
      createdAt: new Date().toISOString(),
      reviewConfig: { ...DEFAULT_REVIEW_CONFIG },
      cards: [],
    };
    this.books.set(book.id, book);
    await this.saveBook(book);
    return book;
  }

  /** 删除词本（含全部卡片，不可恢复）。至少保留一个词本。 */
  async deleteBook(id: string): Promise<boolean> {
    if (!this.books.has(id) || this.books.size <= 1) return false;
    this.books.delete(id);
    this.rebuildIndex();
    await this.storage.remove?.(`${this.folder}/${id}.json`);
    this.events.onChange?.();
    return true;
  }

  async renameBook(id: string, name: string): Promise<void> {
    const book = this.books.get(id);
    if (!book) return;
    book.name = name;
    await this.saveBook(book);
  }

  stats(bookId: string, now = new Date()): BookStats | null {
    const book = this.books.get(bookId);
    if (!book) return null;
    let mastered = 0, learning = 0, notStarted = 0, dueToday = 0, newAvailable = 0;
    for (const c of book.cards) {
      if (c.status === 'mastered') mastered++;
      else if (c.fsrs.reps > 0) { learning++; if (isDue(c, now)) dueToday++; }
      else { notStarted++; newAvailable++; }
    }
    return { total: book.cards.length, mastered, learning, notStarted, dueToday, newAvailable };
  }

  // ---------- cards ----------

  findByLemma(lemma: string): { book: WordBook; card: WordCard } | null {
    const hit = this.lemmaIndex.get(lemma.toLowerCase());
    if (!hit) return null;
    const book = this.books.get(hit.bookId);
    const card = book?.cards.find((c) => c.id === hit.cardId);
    return book && card ? { book, card } : null;
  }

  isCollected(lemma: string): boolean {
    return this.lemmaIndex.has(lemma.toLowerCase());
  }

  isMastered(lemma: string): boolean {
    return this.mastered.has(lemma.toLowerCase());
  }

  /** Collect a word into a book from a dictionary entry (or manual input). */
  async collect(
    bookId: string,
    entry: WordEntry,
    context?: CardContext,
  ): Promise<{ card: WordCard; existed: boolean }> {
    const lemma = entry.lemma.toLowerCase();
    const existing = this.findByLemma(lemma);
    if (existing) return { card: existing.card, existed: true };
    const book = this.books.get(bookId);
    if (!book) throw new Error(`book not found: ${bookId}`);
    const card: WordCard = {
      id: makeId('card'),
      lemma,
      variants: entry.variants,
      phoneticUS: entry.phoneticUS,
      phoneticUK: entry.phoneticUK,
      senses: entry.senses,
      definitionEn: entry.definitionEn,
      tags: entry.tags,
      addedAt: new Date().toISOString(),
      contexts: context?.sentence ? [context] : [],
      dictExamples: entry.examples?.slice(0, 2),
      fsrs: newFsrsState(),
      status: 'new',
    };
    book.cards.push(card);
    this.lemmaIndex.set(lemma, { bookId: book.id, cardId: card.id });
    this.mastered.delete(lemma);
    await this.saveBook(book);
    return { card, existed: false };
  }

  /** Append an example sentence to an existing card (dedup by sentence). */
  async addContext(lemma: string, context: CardContext): Promise<boolean> {
    const hit = this.findByLemma(lemma);
    if (!hit || !context.sentence) return false;
    if (hit.card.contexts.some((c) => c.sentence === context.sentence)) return false;
    hit.card.contexts.push(context);
    if (hit.card.contexts.length > 10) hit.card.contexts.shift();
    await this.saveBook(hit.book);
    return true;
  }

  /** Apply a review rating per the book's scheduler + persist. */
  async applyRating(lemma: string, rating: ReviewRating, now = new Date()): Promise<WordCard | null> {
    const hit = this.findByLemma(lemma);
    if (!hit) return null;
    hit.card.fsrs = rateWith(hit.book.reviewConfig.algorithm ?? 'fsrs', hit.card.fsrs, rating, now);
    if (hit.card.status === 'new') hit.card.status = 'learning';
    await this.saveBook(hit.book);
    return hit.card;
  }

  /** 用词典条目补全旧卡片的快照（音标/释义/词典例句等）。 */
  async refreshSnapshot(lemma: string, entry: WordEntry): Promise<boolean> {
    const hit = this.findByLemma(lemma);
    if (!hit) return false;
    const c = hit.card;
    let changed = false;
    if (!c.phoneticUS && entry.phoneticUS) { c.phoneticUS = entry.phoneticUS; changed = true; }
    const hasCjk = (arr: string[]): boolean => arr.some((x) => /[一-鿿]/.test(x));
    if (entry.senses.length && (c.senses.length === 0 || (!hasCjk(c.senses) && hasCjk(entry.senses)))) {
      // 旧的纯英文快照被中文释义替换时，英文挪去英释位
      if (c.senses.length > 0 && !c.definitionEn?.length) c.definitionEn = c.senses.slice(0, 1);
      c.senses = entry.senses;
      changed = true;
    }
    if (!c.definitionEn?.length && entry.definitionEn?.length) { c.definitionEn = entry.definitionEn; changed = true; }
    if ((!c.dictExamples || c.dictExamples.length === 0) && entry.examples?.length) {
      c.dictExamples = entry.examples.slice(0, 2); changed = true;
    }
    if (c.variants.length === 0 && entry.variants.length) { c.variants = entry.variants; changed = true; }
    if (changed) await this.saveBook(hit.book);
    return changed;
  }

  async updateReviewConfig(bookId: string, patch: Partial<WordBook['reviewConfig']>): Promise<void> {
    const book = this.books.get(bookId);
    if (!book) return;
    book.reviewConfig = { ...book.reviewConfig, ...patch };
    await this.saveBook(book);
  }

  async removeCard(lemma: string): Promise<boolean> {
    const hit = this.findByLemma(lemma);
    if (!hit) return false;
    hit.book.cards = hit.book.cards.filter((c) => c.id !== hit.card.id);
    this.lemmaIndex.delete(hit.card.lemma);
    await this.saveBook(hit.book);
    return true;
  }

  async setMastered(lemma: string, mastered: boolean): Promise<void> {
    const key = lemma.toLowerCase();
    const hit = this.findByLemma(key);
    if (hit) {
      hit.card.status = mastered ? 'mastered' : (hit.card.fsrs.reps > 0 ? 'learning' : 'new');
      await this.saveBook(hit.book);
    }
    if (mastered) this.mastered.add(key); else this.mastered.delete(key);
    await this.saveMastered();
  }

  /** Bulk import of known words (e.g. known-words.txt). Returns count added. */
  async importMastered(words: string[]): Promise<number> {
    let added = 0;
    for (const w of words) {
      const key = w.trim().toLowerCase();
      if (!key || /[^a-z'-]/.test(key)) continue;
      if (!this.mastered.has(key)) { this.mastered.add(key); added++; }
    }
    if (added) await this.saveMastered();
    return added;
  }

  masteredList(): string[] {
    return [...this.mastered];
  }
}
