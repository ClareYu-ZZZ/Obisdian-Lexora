/**
 * @elp/core — shared data model.
 * Host-agnostic: no Obsidian, no Node-only APIs.
 */

/** A dictionary entry (read-only, comes from the dictionary provider). */
export interface WordEntry {
  /** Canonical form (lowercase lemma as it appears in the dictionary). */
  lemma: string;
  /** IPA, US. May be empty when the source lacks it. */
  phoneticUS: string;
  /** IPA, UK (optional). */
  phoneticUK?: string;
  /** Sense lines, already human-readable (e.g. "n. 种族；竞赛"). */
  senses: string[];
  /** English definition lines (optional). */
  definitionEn?: string[];
  /** Exam/level tags: cet4 cet6 ky toefl ielts gre zk gk ... */
  tags: string[];
  /** Frequency rank (lower = more common). 0/undefined = unknown. */
  freqRank?: number;
  /** Inflected surface forms derived from the exchange field (not incl. lemma). */
  variants: string[];
  /** Dictionary example sentences（自建词库 examples.json 提供）. */
  examples?: Array<{ en: string; zh?: string }>;
}

/** FSRS scheduling state — mirrors ts-fsrs Card, kept JSON-friendly. */
export interface FsrsState {
  due: string;            // ISO date
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;          // 0 New | 1 Learning | 2 Review | 3 Relearning
  last_review?: string;   // ISO date
}

export type CardStatus = 'new' | 'learning' | 'mastered';

/** Where a word was collected from. */
export interface CardContext {
  sentence: string;
  sourcePath?: string;    // vault-relative path of the note
  sourceTitle?: string;
}

/** A collected word, owned by exactly one book. */
export interface WordCard {
  id: string;
  lemma: string;
  /** Surface forms that should also be highlighted (plural, past tense, ...). */
  variants: string[];
  /** Snapshot of dictionary info so the card works without the dictionary. */
  phoneticUS: string;
  phoneticUK?: string;
  senses: string[];
  /** English definition lines (snapshot, optional). */
  definitionEn?: string[];
  tags: string[];
  addedAt: string;        // ISO date
  /** Example sentences collected from real usage (newest last). */
  contexts: CardContext[];
  /** Dictionary examples snapshot（收词时来自词库）. */
  dictExamples?: Array<{ en: string; zh?: string }>;
  /** @deprecated pre-0.2 single context; migrated into `contexts` on load. */
  context?: CardContext;
  fsrs: FsrsState;
  status: CardStatus;
}

export type ReviewMode =
  | 'card'            // 卡片模式
  | 'choice-meaning'  // 释义选择
  | 'choice-word'     // 中文选词
  | 'spelling'        // 拼写模式
  | 'listening'       // 听音辨意
  | 'listening-spell' // 听写模式（听音拼写）
  | 'cloze-spell';    // 例句拼写（挖空填词）

export const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  card: '卡片模式',
  'choice-meaning': '释义选择',
  'choice-word': '中文选词',
  spelling: '拼写模式',
  listening: '听音辨意',
  'listening-spell': '听写模式',
  'cloze-spell': '例句拼写',
};

export type SchedulerAlgo = 'fsrs' | 'sm2' | 'leitner';

export const SCHEDULER_LABELS: Record<SchedulerAlgo, string> = {
  fsrs: 'FSRS（推荐，现代算法）',
  sm2: 'SM-2（Anki 经典）',
  leitner: 'Leitner 盒子（简单固定间隔）',
};

export interface ReviewConfig {
  /** 记忆曲线算法 */
  algorithm: SchedulerAlgo;
  newPerDay: number;
  reviewsPerDay: number;
  autoPronounce: boolean;
  /** Show an example sentence on the card front. */
  showExample: boolean;
  /** Rotate a random example each time (vs always the first). */
  randomExample: boolean;
  /** Review modes enabled for this book; one is picked per card. */
  modes: ReviewMode[];
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  algorithm: 'fsrs',
  newPerDay: 20,
  reviewsPerDay: 200,
  autoPronounce: true,
  showExample: true,
  randomExample: true,
  modes: ['card'],
};

export interface WordBook {
  id: string;
  name: string;
  icon?: string;
  /** 词本标识色（自动分配，体现在下划线/词本 tab 等处）。 */
  color?: string;
  createdAt: string;
  reviewConfig: ReviewConfig;
  cards: WordCard[];
}

/** Aggregate stats for a book (drives the progress UI). */
export interface BookStats {
  total: number;
  mastered: number;
  learning: number;
  notStarted: number;
  dueToday: number;
  newAvailable: number;
}

/** Minimal file IO the host must provide (vault on Obsidian, fs on Node). */
export interface StorageAdapter {
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** List file names (not paths) directly under a folder; [] if missing. */
  list(folder: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';
