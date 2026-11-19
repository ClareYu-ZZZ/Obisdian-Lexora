import { Platform } from 'obsidian';
import type ElpPlugin from './main';
import { pronounce } from './audio';
import { lookupOnline } from './online-dict';
import { STATUS_LABEL, iconButton, renderSentence } from './ui';

const SHOW_DELAY = 180;
const HIDE_DELAY = 260;

/** Rich hover card for highlighted words (editor + reading view). */
export class HoverManager {
  private el: HTMLDivElement | null = null;
  private showTimer: number | null = null;
  private hideTimer: number | null = null;
  private currentLemma: string | null = null;

  constructor(private plugin: ElpPlugin) {}

  attach(): void {
    this.plugin.registerDomEvent(document, 'mouseover', (ev) => {
      const target = ev.target as HTMLElement | null;
      const wordEl = target?.closest?.('.elp-word') as HTMLElement | null;
      if (wordEl) {
        const lemma = wordEl.getAttribute('data-elp-lemma');
        if (lemma) this.scheduleShow(lemma, wordEl);
        return;
      }
      if (target?.closest?.('.elp-popover')) {
        this.cancelHide();
        return;
      }
      this.scheduleHide();
    });
    this.plugin.registerDomEvent(document, 'mousedown', (ev) => {
      if (!(ev.target as HTMLElement | null)?.closest?.('.elp-popover')) this.hide();
    });
    // 触屏：mouseover 只在首次 tap 合成且不可靠，补 click 直达路径
    this.plugin.registerDomEvent(document, 'click', (ev) => {
      if (!Platform.isMobileApp) return;
      const wordEl = (ev.target as HTMLElement | null)?.closest?.('.elp-word') as HTMLElement | null;
      const lemma = wordEl?.getAttribute('data-elp-lemma');
      if (wordEl && lemma) {
        this.cancelHide();
        this.show(lemma, wordEl);
      }
    });
  }

  detach(): void {
    this.hide();
  }

  private scheduleShow(lemma: string, anchor: HTMLElement): void {
    this.cancelHide();
    if (this.currentLemma === lemma && this.el) return;
    if (this.showTimer) window.clearTimeout(this.showTimer);
    this.showTimer = window.setTimeout(() => this.show(lemma, anchor), SHOW_DELAY);
  }

  private scheduleHide(): void {
    if (this.showTimer) { window.clearTimeout(this.showTimer); this.showTimer = null; }
    if (this.hideTimer || !this.el) return;
    this.hideTimer = window.setTimeout(() => this.hide(), HIDE_DELAY);
  }

  private cancelHide(): void {
    if (this.hideTimer) { window.clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  hide(): void {
    this.cancelHide();
    if (this.showTimer) { window.clearTimeout(this.showTimer); this.showTimer = null; }
    this.el?.remove();
    this.el = null;
    this.currentLemma = null;
  }

  private show(lemma: string, anchor: HTMLElement): void {
    this.hide();
    const hit = this.plugin.store.findByLemma(lemma);
    if (!hit) return;
    const { card, book } = hit;

    const el = document.createElement('div');
    el.className = 'elp-popover';

    // ----- head: word · phonetics · speak -----
    const head = el.createDiv({ cls: 'elp-popover-head' });
    const title = head.createDiv({ cls: 'elp-popover-title' });
    title.createSpan({ cls: 'elp-popover-word', text: card.lemma });
    const phon = title.createDiv({ cls: 'elp-popover-phonetics' });
    if (card.phoneticUS) phon.createSpan({ cls: 'elp-popover-phonetic', text: `美 ${card.phoneticUS}` });
    if (card.phoneticUK) phon.createSpan({ cls: 'elp-popover-phonetic', text: `英 ${card.phoneticUK}` });
    iconButton(head, 'volume-2', '发音', () => pronounce(card.lemma), 'elp-popover-speak');

    // ----- tags -----
    if (card.tags.length) {
      const tags = el.createDiv({ cls: 'elp-popover-tags' });
      for (const t of card.tags.slice(0, 6)) tags.createSpan({ cls: 'elp-tag', text: t });
    }

    // ----- senses -----
    const senses = el.createEl('ul', {
      cls: 'elp-popover-senses' + (this.plugin.settings.blurDefinitions ? ' elp-blur' : ''),
    });
    for (const s of card.senses.slice(0, 4)) senses.createEl('li', { text: s });
    const hasCjk = card.senses.some((x) => /[\u4e00-\u9fff]/.test(x));
    if (card.senses.length === 0 || !hasCjk) {
      const ph = senses.createEl('li', { cls: 'elp-muted', text: card.senses.length ? '正在补全中文释义…' : '正在补全释义…' });
      void (async () => {
        let entry = (await this.plugin.dict.isReady()) ? await this.plugin.dict.lookup(card.lemma) : null;
        if (!entry || entry.senses.length === 0) entry = await lookupOnline(card.lemma);
        if (!entry || entry.senses.length === 0) { ph.setText('（无释义快照）'); return; }
        await this.plugin.store.refreshSnapshot(card.lemma, entry);
        if (this.currentLemma !== lemma) return;
        ph.remove();
        senses.empty();
        for (const sn of entry.senses.slice(0, 4)) senses.createEl('li', { text: sn });
        if (!card.phoneticUS && entry.phoneticUS) phon.createSpan({ cls: 'elp-popover-phonetic', text: `美 ${entry.phoneticUS}` });
      })();
    }
    if (card.definitionEn?.length) {
      el.createDiv({ cls: 'elp-popover-defen', text: card.definitionEn[0] });
    }

    // ----- examples：语境例句 + 词典例句 -----
    if (card.contexts.length || card.dictExamples?.length) {
      const exWrap = el.createDiv({ cls: 'elp-popover-examples' });
      exWrap.createDiv({ cls: 'elp-section-label' }).createSpan({ text: '例句' });
      const exampleRow = (cls: string, en: string, sub?: string) => {
        const row = exWrap.createDiv({ cls });
        const main = row.createDiv({ cls: 'elp-popover-example-main' });
        const sent = main.createDiv({ cls: 'elp-popover-sentence' });
        renderSentence(sent, en, card.lemma, card.variants);
        iconButton(main, 'volume-2', '朗读例句', () => pronounce(en), 'elp-example-speak');
        if (sub) row.createDiv({ cls: 'elp-popover-source', text: sub });
      };
      for (const ctx of card.contexts.slice(-2).reverse()) {
        exampleRow('elp-popover-example', ctx.sentence, ctx.sourceTitle ? `— ${ctx.sourceTitle}` : undefined);
      }
      for (const ex of (card.dictExamples ?? []).slice(0, card.contexts.length ? 1 : 2)) {
        exampleRow('elp-popover-example elp-dict-example', ex.en, ex.zh);
      }
    }

    // ----- footer: status · book · actions -----
    const foot = el.createDiv({ cls: 'elp-popover-foot' });
    foot.createSpan({ cls: `elp-badge elp-badge-${card.status}`, text: STATUS_LABEL[card.status] });
    const bookEl = foot.createSpan({ cls: 'elp-popover-book', text: book.name });
    if (book.color) {
      const dot = bookEl.createSpan({ cls: 'elp-book-dot' });
      dot.style.background = book.color;
      bookEl.prepend(dot);
    }
    const actions = foot.createDiv({ cls: 'elp-popover-actions' });
    iconButton(
      actions,
      card.status === 'mastered' ? 'rotate-ccw' : 'check',
      card.status === 'mastered' ? '取消已掌握' : '标记已掌握',
      async () => {
        await this.plugin.store.setMastered(card.lemma, card.status !== 'mastered');
        this.hide();
        this.plugin.refreshWord(card.lemma);
      },
    );
    iconButton(actions, 'trash-2', '移出词本', async () => {
      await this.plugin.store.removeCard(card.lemma);
      this.hide();
      this.plugin.refreshWord(card.lemma);
    });

    document.body.appendChild(el);
    const rect = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + box.width > window.innerWidth - 8) left = window.innerWidth - box.width - 8;
    if (top + box.height > window.innerHeight - 8) top = rect.top - box.height - 6;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;

    this.el = el;
    this.currentLemma = lemma;
  }
}
