/** Minimal XML helpers for RSS/Atom feeds (no DOM dependency). */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

export function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** All inner contents of <tag ...>...</tag> occurrences (non-greedy). */
export function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** First tag's inner text, CDATA stripped and entities decoded. */
export function tagText(xml: string, tag: string): string {
  const b = blocks(xml, tag);
  if (b.length === 0) return '';
  return decodeEntities(stripCdata(b[0])).trim();
}

/** First <tag ... attr="value"> attribute value. */
export function attrOf(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}\\s[^>]*?${attr}="([^"]*)"`);
  const m = re.exec(xml);
  return m ? decodeEntities(m[1]) : '';
}

/** Strip HTML tags to text, preserving paragraph breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    stripCdata(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
