import { App, Modal, Notice, setIcon } from 'obsidian';
import type { SampledWord } from '@elp/core';
import type ElpPlugin from './main';
import { pronounce } from './audio';
import { iconButton } from './ui';

/**
 * 词汇量测试：按词频 5 个区间各抽 8 词自测（认识/不认识），
 * 按每层命中率 × 层宽估算词汇量。结果存档，统计横幅展示最近一次。
 */

const BANDS: Array<[number, number]> = [
  [1, 2000], [2001, 4000], [4001, 8000], [8001, 16000], [16001, 30000],
];
const BAND_WIDTH = [2000, 2000, 4000, 8000, 14000];
const PER_BAND = 8;

export class VocabTestModal extends Modal {
  private words: SampledWord[] = [];
  private idx = 0;
  private known: boolean[] = [];
  private phase: 'intro' | 'test' | 'result' = 'intro';
  private keyHandler = (e: KeyboardEvent) => {
    if (this.phase !== 'test') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); this.answer(true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.answer(false); }
  };

  constructor(app: App, private plugin: ElpPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('elp-vocab-modal');
    window.addEventListener('keydown', this.keyHandler);
    this.render();
  }

  onClose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.contentEl.empty();
  }

  private async start(): Promise<void> {
    if (!(await this.plugin.dict.isReady())) {
      new Notice('词典索引未构建，无法测试');
      return;
    }
    const notice = new Notice('抽取测试词…', 0);
    this.words = await this.plugin.dict.sampleByBand(BANDS, PER_BAND);
    notice.hide();
    if (this.words.length < PER_BAND * 2) {
      new Notice('词库样本不足（词频数据缺失）');
      return;
    }
    // 打乱顺序，避免按难度递增带来的心理暗示
    for (let i = this.words.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.words[i], this.words[j]] = [this.words[j], this.words[i]];
    }
    this.idx = 0;
    this.known = [];
    this.phase = 'test';
    this.render();
  }

  private answer(know: boolean): void {
    this.known[this.idx] = know;
    this.idx++;
    if (this.idx >= this.words.length) {
      this.phase = 'result';
      void this.saveResult();
    }
    this.render();
  }

  private estimate(): { total: number; perBand: Array<{ ratio: number; count: number }> } {
    const perBand = BANDS.map(() => ({ know: 0, total: 0 }));
    this.words.forEach((w, i) => {
      perBand[w.band].total++;
      if (this.known[i]) perBand[w.band].know++;
    });
    let total = 0;
    const detail = perBand.map((b, i) => {
      const ratio = b.total ? b.know / b.total : 0;
      total += ratio * BAND_WIDTH[i];
      return { ratio, count: b.total };
    });
    return { total: Math.round(total / 50) * 50, perBand: detail };
  }

  private async saveResult(): Promise<void> {
    const { total } = this.estimate();
    this.plugin.settings.vocabTests.push({ date: new Date().toISOString().slice(0, 10), estimate: total });
    if (this.plugin.settings.vocabTests.length > 50) this.plugin.settings.vocabTests.shift();
    await this.plugin.saveSettings();
    this.plugin.refreshBooksViews();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.phase === 'intro') {
      contentEl.createEl('h3', { text: '词汇量测试' });
      contentEl.createEl('p', {
        text: `按词频从高到低分 ${BANDS.length} 个区间抽 ${BANDS.length * PER_BAND} 个词。只看单词本身，认识（知道意思）选 ✓，不确定一律选 ✗，结果才准。约 1 分钟。`,
      });
      const last = this.plugin.settings.vocabTests.at(-1);
      if (last) contentEl.createEl('p', { cls: 'elp-muted', text: `上次：${last.date} · 约 ${last.estimate.toLocaleString()} 词` });
      const btn = contentEl.createEl('button', { cls: 'mod-cta', text: '开始测试' });
      btn.onclick = () => void this.start();
      return;
    }

    if (this.phase === 'test') {
      const w = this.words[this.idx];
      const head = contentEl.createDiv({ cls: 'elp-vocab-head' });
      head.createSpan({ text: `${this.idx + 1} / ${this.words.length}` });
      const wordRow = contentEl.createDiv({ cls: 'elp-vocab-word-row' });
      wordRow.createDiv({ cls: 'elp-review-word', text: w.lemma });
      iconButton(wordRow, 'volume-2', '发音', () => pronounce(w.lemma));
      const btns = contentEl.createDiv({ cls: 'elp-vocab-btns' });
      const no = btns.createEl('button', { cls: 'elp-rate is-again' });
      const noIc = no.createSpan(); setIcon(noIc, 'x');
      no.createSpan({ text: ' 不认识' });
      no.createSpan({ cls: 'elp-rate-key', text: '←' });
      no.onclick = () => this.answer(false);
      const yes = btns.createEl('button', { cls: 'elp-rate is-good' });
      const yesIc = yes.createSpan(); setIcon(yesIc, 'check');
      yes.createSpan({ text: ' 认识' });
      yes.createSpan({ cls: 'elp-rate-key', text: '→' });
      yes.onclick = () => this.answer(true);
      return;
    }

    // result
    const { total, perBand } = this.estimate();
    contentEl.createEl('h3', { text: '测试结果' });
    const big = contentEl.createDiv({ cls: 'elp-vocab-result' });
    big.createSpan({ cls: 'elp-vocab-estimate', text: total.toLocaleString() });
    big.createSpan({ cls: 'elp-muted', text: ' 词（估算）' });
    const bandNames = ['1–2k', '2–4k', '4–8k', '8–16k', '16k+'];
    const list = contentEl.createDiv({ cls: 'elp-vocab-bands' });
    perBand.forEach((b, i) => {
      const row = list.createDiv({ cls: 'elp-vocab-band' });
      row.createSpan({ cls: 'elp-vocab-band-name', text: bandNames[i] });
      const barWrap = row.createDiv({ cls: 'elp-vocab-bar' });
      const bar = barWrap.createDiv({ cls: 'elp-vocab-bar-fill' });
      bar.style.width = `${Math.round(b.ratio * 100)}%`;
      row.createSpan({ cls: 'elp-vocab-band-pct', text: `${Math.round(b.ratio * 100)}%` });
    });
    contentEl.createEl('p', {
      cls: 'elp-muted',
      text: '分层命中率 × 层宽求和的粗估，定期复测看趋势比单次绝对值更有意义。',
    });
    const again = contentEl.createEl('button', { text: '再测一次' });
    again.onclick = () => void this.start();
  }
}
