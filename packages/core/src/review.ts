/**
 * Review sessions: queue building, per-day activity log (drives the charts),
 * and multiple-choice option generation. Pure logic; IO via StorageAdapter.
 */

import { isDue } from './fsrs';
import type { ReviewMode, StorageAdapter, WordBook, WordCard } from './types';

export function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface DayActivity {
  new: number;
  review: number;
  /** Book completion percent snapshot at last activity of the day. */
  progressPct?: number;
}

interface LogFile {
  version: 1;
  /** dayKey -> bookId -> activity */
  days: Record<string, Record<string, DayActivity>>;
}

export class ReviewLog {
  private data: LogFile = { version: 1, days: {} };
  private loaded = false;

  constructor(private storage: StorageAdapter, private path: string) {}

  async load(): Promise<void> {
    const raw = await this.storage.readText(this.path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as LogFile;
        if (parsed?.days) this.data = parsed;
      } catch { /* keep empty */ }
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.storage.writeText(this.path, JSON.stringify(this.data));
  }

  async record(bookId: string, kind: 'new' | 'review', progressPct?: number, now = new Date()): Promise<void> {
    if (!this.loaded) await this.load();
    const key = dayKey(now);
    const day = (this.data.days[key] ??= {});
    const act = (day[bookId] ??= { new: 0, review: 0 });
    act[kind]++;
    if (progressPct !== undefined) act.progressPct = progressPct;
    await this.save();
  }

  today(bookId: string, now = new Date()): DayActivity {
    return this.data.days[dayKey(now)]?.[bookId] ?? { new: 0, review: 0 };
  }

  /** 全部词本合计的某日活动。 */
  dayAggregate(key: string): { new: number; review: number } {
    const day = this.data.days[key] ?? {};
    let n = 0, r = 0;
    for (const act of Object.values(day)) { n += act.new; r += act.review; }
    return { new: n, review: r };
  }

  /** 连续打卡天数（今天有活动则含今天，否则从昨天往回数）。 */
  streak(now = new Date()): { days: number; todayDone: boolean } {
    const todayKey = dayKey(now);
    const todayAct = this.dayAggregate(todayKey);
    const todayDone = todayAct.new + todayAct.review > 0;
    let days = 0;
    const cursor = new Date(now);
    if (!todayDone) cursor.setDate(cursor.getDate() - 1);
    for (;;) {
      const act = this.dayAggregate(dayKey(cursor));
      if (act.new + act.review <= 0) break;
      days++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { days, todayDone };
  }

  /** 累计：活跃天数 / 新词 / 复习。 */
  lifetime(): { activeDays: number; totalNew: number; totalReview: number } {
    let activeDays = 0, totalNew = 0, totalReview = 0;
    for (const key of Object.keys(this.data.days)) {
      const agg = this.dayAggregate(key);
      if (agg.new + agg.review > 0) activeDays++;
      totalNew += agg.new;
      totalReview += agg.review;
    }
    return { activeDays, totalNew, totalReview };
  }

  /** Last n days (oldest first), zero-filled, for the book charts. */
  lastNDays(bookId: string, n: number, now = new Date()): Array<{ date: string } & DayActivity> {
    const out: Array<{ date: string } & DayActivity> = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = dayKey(d);
      const act = this.data.days[key]?.[bookId];
      out.push({ date: key, new: act?.new ?? 0, review: act?.review ?? 0, progressPct: act?.progressPct });
    }
    return out;
  }
}

export interface SessionItem {
  card: WordCard;
  kind: 'new' | 'review';
  mode: ReviewMode;
}

function pickMode(modes: ReviewMode[], card: WordCard): ReviewMode {
  const pool = modes.length ? modes : ['card' as ReviewMode];
  const usable = pool.filter((m) => {
    if (m === 'choice-meaning' || m === 'choice-word' || m === 'listening') return card.senses.length > 0;
    if (m === 'cloze-spell') return card.contexts.length > 0 || (card.dictExamples?.length ?? 0) > 0;
    if (m === 'spelling') return card.senses.length > 0;
    return true;
  });
  const effective = usable.length ? usable : ['card' as ReviewMode];
  return effective[Math.floor(Math.random() * effective.length)];
}

/**
 * Build today's queue for a book: due reviews first (oldest due first),
 * then new cards, both capped by the book's daily limits minus what the
 * log says was already done today.
 */
export function buildSession(book: WordBook, log: ReviewLog, now = new Date()): SessionItem[] {
  const cfg = book.reviewConfig;
  const done = log.today(book.id, now);
  const reviewBudget = Math.max(0, cfg.reviewsPerDay - done.review);
  const newBudget = Math.max(0, cfg.newPerDay - done.new);

  const due = book.cards
    .filter((c) => c.status === 'learning' && isDue(c, now))
    .sort((a, b) => a.fsrs.due.localeCompare(b.fsrs.due))
    .slice(0, reviewBudget);

  const fresh = book.cards
    .filter((c) => c.status === 'new')
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
    .slice(0, newBudget);

  const items: SessionItem[] = [
    ...due.map((card) => ({ card, kind: 'review' as const, mode: pickMode(cfg.modes, card) })),
    ...fresh.map((card) => ({ card, kind: 'new' as const, mode: pickMode(cfg.modes, card) })),
  ];
  return items;
}

export interface ChoiceOption {
  text: string;
  correct: boolean;
}

function firstSense(card: WordCard): string {
  return card.senses[0] ?? '';
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Options for choice modes. `field` 'sense': options are meanings (释义选择 /
 * 听音辨意); 'word': options are words (中文选词).
 */
export function buildChoices(
  target: WordCard, pool: WordCard[], field: 'sense' | 'word', count = 4,
): ChoiceOption[] {
  const key = (c: WordCard) => (field === 'sense' ? firstSense(c) : c.lemma);
  const correctText = key(target);
  const distractors = shuffle(
    pool.filter((c) => c.id !== target.id && key(c) && key(c) !== correctText),
  ).slice(0, count - 1);
  const options: ChoiceOption[] = [
    { text: correctText, correct: true },
    ...distractors.map((c) => ({ text: key(c), correct: false })),
  ];
  return shuffle(options);
}

/** Pick the example sentence to show on a card front（语境例句优先，词典例句兜底）. */
export function pickExample(card: WordCard, random: boolean): string | null {
  const pool: string[] = [
    ...card.contexts.map((c) => c.sentence),
    ...(card.dictExamples ?? []).map((e) => e.en),
  ].filter(Boolean);
  if (pool.length === 0) return null;
  const idx = random ? Math.floor(Math.random() * pool.length) : 0;
  return pool[idx] ?? null;
}
