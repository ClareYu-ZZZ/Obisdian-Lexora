/**
 * Subtitle parsing (VTT/SRT) and sentence segmentation with timeline
 * alignment — the core of 长难句/段落跟读 and jump-to-source.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
  /** 词级时间轴（YouTube ASR 字幕的 <00:00:00.000> 标记），有则对齐用它。 */
  words?: Array<{ t: number; w: string }>;
}

export interface LessonSegment {
  text: string;
  /** seconds; undefined for text-only sources */
  start?: number;
  end?: number;
  paragraph: number;
}

function parseTimestamp(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
}

function cleanCueText(t: string): string {
  return t
    .replace(/<[^>]+>/g, '')          // strip <c>, <00:00:00.000> etc.
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/(^|\s)>>+\s*/g, '$1')   // 手工字幕的说话人标记 ">>"（实体解码后再清）
    .replace(/\s+/g, ' ')
    .trim();
}

const INLINE_TS = /<(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})>/g;

/** 解析带词级时间戳的行："word1<00:00:01.040><c> word2</c>…" → [{t, w}] */
function parseTimedLine(line: string, cueStart: number): Array<{ t: number; w: string }> {
  const words: Array<{ t: number; w: string }> = [];
  let last = 0;
  let curT = cueStart;
  INLINE_TS.lastIndex = 0;
  let m: RegExpExecArray | null;
  const flush = (chunk: string, t: number) => {
    for (const w of cleanCueText(chunk).split(' ')) {
      if (w) words.push({ t, w });
    }
  };
  while ((m = INLINE_TS.exec(line))) {
    flush(line.slice(last, m.index), curT);
    curT = parseTimestamp(m[1]) ?? curT;
    last = INLINE_TS.lastIndex;
  }
  flush(line.slice(last), curT);
  return words;
}

export function parseSubtitle(src: string): Cue[] {
  const lines = src.replace(/\r/g, '').split('\n');
  // YouTube ASR 滚动字幕：每条 cue 重复上一条的尾行 + 一条带词级时间戳的新行。
  // 只有带时间戳的行是"新内容"，重复的纯文本行必须丢弃，否则正文重复、时间轴被撑歪。
  const hasInlineTs = /<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/.test(src);
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const arrow = line.includes('-->') ? line : '';
    if (!arrow) { i++; continue; }
    const [a, b] = arrow.split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp((b ?? '').split(/\s/).filter(Boolean)[0] ?? '');
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) {
      textLines.push(lines[i]);
      i++;
    }
    if (start == null || end == null) continue;

    if (hasInlineTs) {
      const timed = textLines.filter((l) => /<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/.test(l));
      if (timed.length === 0) continue; // 纯重复行的 cue，整条丢弃
      const words = timed.flatMap((l) => parseTimedLine(l, start));
      if (words.length === 0) continue;
      cues.push({ start, end, text: words.map((w) => w.w).join(' '), words });
      continue;
    }

    const text = cleanCueText(textLines.join(' '));
    if (text) cues.push({ start, end, text });
  }
  return hasInlineTs ? cues : mergeRollups(cues);
}

/** YouTube auto-captions repeat lines as they roll; collapse them. */
function mergeRollups(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (prev) {
      if (cue.text === prev.text) { prev.end = cue.end; continue; }
      if (cue.text.startsWith(prev.text) && cue.text.length > prev.text.length) {
        prev.text = cue.text;
        prev.end = cue.end;
        continue;
      }
    }
    out.push({ ...cue });
  }
  return out;
}

const SENTENCE_END = /([.!?…]+["')\]]?)(\s+|$)/g;

function splitSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let last = 0;
  SENTENCE_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END.exec(text))) {
    const end = m.index + m[1].length;
    const chunk = text.slice(last, end).trim();
    if (chunk) out.push({ text: chunk, start: last, end });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) out.push({ text: tail, start: last, end: text.length });
  return out;
}

/**
 * Join cues into one stream, split into sentences, and give each sentence
 * a [start,end] interpolated from the cue timings its characters span.
 * A silence gap > 3s starts a new paragraph.
 */
export function cuesToSegments(cues: Cue[]): LessonSegment[] {
  if (cues.length === 0) return [];
  let joined = '';
  const spans: Array<{ c0: number; c1: number; t0: number; t1: number }> = [];
  const paraBreakAt: number[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (i > 0) {
      if (cue.start - cues[i - 1].end > 3) paraBreakAt.push(joined.length);
      joined += ' ';
    }
    if (cue.words?.length) {
      // 词级时间轴：每个词一个 span，对齐精度到词
      for (let w = 0; w < cue.words.length; w++) {
        if (w > 0) joined += ' ';
        const c0 = joined.length;
        joined += cue.words[w].w;
        spans.push({
          c0,
          c1: joined.length,
          t0: cue.words[w].t,
          t1: cue.words[w + 1]?.t ?? cue.end,
        });
      }
    } else {
      const c0 = joined.length;
      joined += cue.text;
      spans.push({ c0, c1: joined.length, t0: cue.start, t1: cue.end });
    }
  }
  // 旧套件 mine_vtt.py 的 time_of 同款：句子起点 = 首字符所在 span 的开始，
  // 终点 = 末字符所在 span 的结束，整 span 粒度、不做内插。
  // cue 粒度宁可多盖（相邻句略有重叠，与旧套件一致），绝不漏句；
  // 词级时间轴（ASR）天然精确，同一逻辑直接得到词粒度边界。
  const timeAt = (charIdx: number, edge: 'start' | 'end'): number => {
    for (const s of spans) {
      if (charIdx <= s.c1) return edge === 'start' ? s.t0 : s.t1;
    }
    const lastSpan = spans[spans.length - 1];
    return edge === 'start' ? lastSpan.t0 : lastSpan.t1;
  };

  const segs: LessonSegment[] = [];
  let para = 0;
  let breakPtr = 0;
  for (const s of splitSentences(joined)) {
    while (breakPtr < paraBreakAt.length && paraBreakAt[breakPtr] <= s.start) { para++; breakPtr++; }
    const st = timeAt(s.start, 'start');
    let en = timeAt(Math.max(s.start, s.end - 1), 'end');
    if (en <= st) en = st + 0.3;
    segs.push({
      text: s.text,
      start: Math.round(st * 100) / 100,
      end: Math.round(en * 100) / 100,
      paragraph: para,
    });
  }
  return segs;
}

/** Plain text (articles/notes) → sentence segments, paragraphs by blank line. */
export function textToSegments(text: string): LessonSegment[] {
  const segs: LessonSegment[] = [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  paragraphs.forEach((p, para) => {
    for (const s of splitSentences(p)) {
      segs.push({ text: s.text, paragraph: para });
    }
  });
  return segs;
}
