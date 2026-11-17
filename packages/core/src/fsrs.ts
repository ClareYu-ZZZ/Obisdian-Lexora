/** Thin wrapper around ts-fsrs keeping card state JSON-friendly. */

import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from 'ts-fsrs';
import type { FsrsState, ReviewRating, SchedulerAlgo, WordCard } from './types';

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));

export function newFsrsState(now = new Date()): FsrsState {
  return toState(createEmptyCard(now));
}

function toState(c: Card): FsrsState {
  return {
    due: new Date(c.due).toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: (c as unknown as { learning_steps?: number }).learning_steps ?? 0,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as number,
    last_review: c.last_review ? new Date(c.last_review).toISOString() : undefined,
  };
}

function fromState(s: FsrsState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  } as Card;
}

const RATING: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/** Apply a review rating; returns the next FSRS state. */
export function rate(state: FsrsState, rating: ReviewRating, now = new Date()): FsrsState {
  const result = scheduler.next(fromState(state), now, RATING[rating]);
  return toState(result.card);
}

const DAY = 86400000;

function shiftDue(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY).toISOString();
}

/** SM-2：stability 字段复用为 EF，scheduled_days 为间隔。 */
function rateSm2(s: FsrsState, rating: ReviewRating, now: Date): FsrsState {
  const q = { again: 2, hard: 3, good: 4, easy: 5 }[rating];
  let ef = s.reps > 0 && s.stability > 1.2 ? s.stability : 2.5;
  ef = Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  let interval: number;
  let reps = s.reps + 1;
  let lapses = s.lapses;
  if (rating === 'again') {
    interval = 1; reps = 0; lapses++;
  } else if (s.reps === 0) interval = 1;
  else if (s.reps === 1) interval = 6;
  else interval = Math.round(Math.max(1, s.scheduled_days) * ef);
  if (rating === 'hard') interval = Math.max(1, Math.round(interval * 0.8));
  if (rating === 'easy') interval = Math.round(interval * 1.3);
  return {
    ...s, stability: ef, scheduled_days: interval, reps, lapses,
    state: 2, due: shiftDue(now, interval), last_review: now.toISOString(),
    elapsed_days: 0, difficulty: s.difficulty || 5, learning_steps: 0,
  };
}

/** Leitner：learning_steps 字段复用为盒子号 1-5。 */
const LEITNER_DAYS = [1, 2, 4, 7, 15];

function rateLeitner(s: FsrsState, rating: ReviewRating, now: Date): FsrsState {
  let box = Math.min(5, Math.max(1, s.learning_steps || 1));
  if (rating === 'again') box = 1;
  else if (rating === 'good') box = Math.min(5, box + 1);
  else if (rating === 'easy') box = Math.min(5, box + 2);
  const interval = LEITNER_DAYS[box - 1];
  return {
    ...s, learning_steps: box, scheduled_days: interval,
    reps: s.reps + 1, lapses: s.lapses + (rating === 'again' ? 1 : 0),
    state: 2, due: shiftDue(now, interval), last_review: now.toISOString(), elapsed_days: 0,
  };
}

/** 统一入口：按词本配置的算法调度。 */
export function rateWith(algo: SchedulerAlgo, s: FsrsState, rating: ReviewRating, now = new Date()): FsrsState {
  if (algo === 'sm2') return rateSm2(s, rating, now);
  if (algo === 'leitner') return rateLeitner(s, rating, now);
  return rate(s, rating, now);
}

export function isDue(card: WordCard, now = new Date()): boolean {
  return card.status !== 'mastered' && new Date(card.fsrs.due).getTime() <= now.getTime();
}
