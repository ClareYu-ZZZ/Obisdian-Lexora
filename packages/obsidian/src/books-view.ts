import { App, Notice } from 'obsidian';
import { buildSession, type WordBook } from '@elp/core';
import type ElpPlugin from './main';
import { ConfirmModal, TextInputModal, iconButton } from './ui';
import { ReviewConfigModal } from './review-config-modal';
import { VocabTestModal } from './vocab-test';

/** 单词本面板：打卡统计横幅 + 词本进度 + 图表。 */
export class BooksPanel {
  private root!: HTMLElement;
  private selectedId: string | null = null;

  constructor(
    private plugin: ElpPlugin,
    private app: App,
    private onStartReview: (bookId: string) => void,
  ) {}

  mount(root: HTMLElement): void {
    this.root = root;
    this.render();
  }

  requestRefresh(): void {
    if (this.root) this.render();
  }

  private render(): void {
    const root = this.root;
    root.empty();
    root.addClass('elp-books');

    const books = this.plugin.store.listBooks();
    if (!this.selectedId || !books.find((b) => b.id === this.selectedId)) {
      this.selectedId = this.plugin.settings.defaultBookId || books[0]?.id || null;
    }

    this.renderStatsBanner(root, books);

    const tabs = root.createDiv({ cls: 'elp-books-tabs' });
    for (const b of books) {
      const tab = tabs.createEl('button', {
        cls: 'elp-books-tab' + (b.id === this.selectedId ? ' is-active' : ''),
      });
      if (b.color) {
        const dot = tab.createSpan({ cls: 'elp-book-dot' });
        dot.style.background = b.color;
        if (b.id === this.selectedId) tab.style.borderColor = b.color;
      }
      tab.createSpan({ text: b.name });
      tab.onclick = () => { this.selectedId = b.id; this.render(); };
    }
    iconButton(tabs, 'plus', '新建词本', () => {
      new TextInputModal(this.app, '新建词本', `新词本 ${books.length + 1}`, async (name) => {
        const book = await this.plugin.store.createBook(name);
        this.selectedId = book.id;
        this.plugin.refreshAll();
      }).open();
    }, 'elp-books-add');

    const book = books.find((b) => b.id === this.selectedId);
    if (!book) { root.createDiv({ text: '还没有词本。' }); return; }
    this.renderBook(root, book);
  }

  /** 打卡与统计横幅。 */
  private renderStatsBanner(root: HTMLElement, books: WordBook[]): void {
    const banner = root.createDiv({ cls: 'elp-stats-banner' });

    const streak = this.plugin.log.streak();
    const life = this.plugin.log.lifetime();
    let collected = 0, mastered = 0;
    for (const b of books) {
      const st = this.plugin.store.stats(b.id);
      if (st) { collected += st.total; mastered += st.mastered; }
    }

    const stat = (value: string, label: string, accent = false) => {
      const box = banner.createDiv({ cls: 'elp-stat' + (accent ? ' is-accent' : '') });
      box.createDiv({ cls: 'elp-stat-value', text: value });
      box.createDiv({ cls: 'elp-stat-label', text: label });
    };
    stat(String(streak.days), '连续打卡(天)', true);
    stat(String(life.activeDays), '累计学习(天)');
    stat(String(collected), '已收录');
    stat(String(mastered), '已掌握');
    const lastTest = this.plugin.settings.vocabTests.at(-1);
    stat(lastTest ? lastTest.estimate.toLocaleString() : '—', '词汇量(估)');

    const actions = banner.createDiv({ cls: 'elp-stats-actions' });
    const testBtn = actions.createEl('button', { cls: 'elp-books-tab', text: '词汇量测试' });
    testBtn.onclick = () => new VocabTestModal(this.app, this.plugin).open();
    const checkin = actions.createEl('button', {
      cls: streak.todayDone ? 'elp-books-tab elp-checkin-done' : 'mod-cta elp-checkin-btn',
      text: streak.todayDone ? '✓ 今日已打卡' : '今日尚未打卡 · 去打卡',
    });
    checkin.onclick = () => {
      const id = this.plugin.settings.defaultBookId || books[0]?.id;
      if (id) this.onStartReview(id);
    };
  }

  private renderBook(root: HTMLElement, book: WordBook): void {
    const stats = this.plugin.store.stats(book.id)!;
    const session = buildSession(book, this.plugin.log);
    const newCount = session.filter((s) => s.kind === 'new').length;
    const dueCount = session.filter((s) => s.kind === 'review').length;
    const pct = stats.total ? Math.round((stats.mastered / stats.total) * 1000) / 10 : 0;

    const card = root.createDiv({ cls: 'elp-book-card' });
    const head = card.createDiv({ cls: 'elp-book-head' });
    const title = head.createDiv({ cls: 'elp-book-title' });
    title.createSpan({ cls: 'elp-book-name', text: book.name });
    title.createSpan({ cls: 'elp-book-total', text: `词数 ${stats.total}` });
    const headActions = head.createDiv({ cls: 'elp-book-actions' });
    iconButton(headActions, 'pencil', '重命名', () => {
      new TextInputModal(this.app, '重命名词本', book.name, async (name) => {
        await this.plugin.store.renameBook(book.id, name);
        this.plugin.refreshAll();
      }).open();
    });
    iconButton(headActions, 'trash-2', '删除词本', () => {
      if (this.plugin.store.listBooks().length <= 1) {
        new Notice('至少保留一个词本');
        return;
      }
      new ConfirmModal(
        this.app,
        `删除「${book.name}」？`,
        `将删除该词本及其 ${book.cards.length} 张卡片（含复习进度），不可恢复。`,
        '删除',
        async () => {
          await this.plugin.store.deleteBook(book.id);
          this.selectedId = null;
          if (this.plugin.settings.defaultBookId === book.id) {
            this.plugin.settings.defaultBookId = this.plugin.store.listBooks()[0]?.id ?? '';
            await this.plugin.saveSettings();
          }
          this.plugin.refreshAll();
        },
      ).open();
    });
    iconButton(headActions, 'settings-2', '复习设置', () => {
      new ReviewConfigModal(this.app, this.plugin, book, () => this.render()).open();
    });

    const bar = card.createDiv({ cls: 'elp-progress' });
    const seg = (cls: string, n: number) => {
      const el = bar.createDiv({ cls: `elp-progress-seg ${cls}` });
      el.style.width = stats.total ? `${(n / stats.total) * 100}%` : '0%';
    };
    seg('is-mastered', stats.mastered);
    seg('is-learning', stats.learning);
    const legend = card.createDiv({ cls: 'elp-progress-legend' });
    const leg = (cls: string, label: string, n: number) => {
      const s = legend.createSpan({ cls: 'elp-sidebar-stat' });
      s.createSpan({ cls: `elp-dot elp-dot-${cls}` });
      s.createSpan({ text: `${label} ${n}` });
    };
    leg('mastered', '已掌握', stats.mastered);
    leg('learning', '学习中', stats.learning);
    leg('new', '未学习', stats.notStarted);

    const row = card.createDiv({ cls: 'elp-book-numbers' });
    const num = (value: string, label: string) => {
      const n = row.createDiv({ cls: 'elp-book-num' });
      n.createDiv({ cls: 'elp-book-num-value', text: value });
      n.createDiv({ cls: 'elp-book-num-label', text: label });
    };
    num(String(newCount), '待学新词');
    num(String(dueCount), '待复习');
    num(`${pct}%`, '完成度');
    const cta = row.createDiv({ cls: 'elp-book-cta' });
    const start = cta.createEl('button', { cls: 'mod-cta elp-start-btn', text: '开始学习' });
    start.onclick = () => this.onStartReview(book.id);
    if (session.length === 0) {
      start.setAttr('disabled', 'true');
      start.setText('今日已完成');
    }

    const days = this.plugin.log.lastNDays(book.id, 14);
    const chartsWrap = root.createDiv({ cls: 'elp-charts' });
    this.renderActivityChart(chartsWrap, days);
    this.renderProgressChart(chartsWrap, days, pct);
  }

  private renderActivityChart(
    parent: HTMLElement,
    days: Array<{ date: string; new: number; review: number }>,
  ): void {
    const panel = parent.createDiv({ cls: 'elp-chart-panel' });
    const head = panel.createDiv({ cls: 'elp-chart-head' });
    head.createSpan({ cls: 'elp-chart-title', text: '单词数量' });
    const legend = head.createDiv({ cls: 'elp-chart-legend' });
    legend.createSpan({ cls: 'elp-legend-new', text: '● 新词' });
    legend.createSpan({ cls: 'elp-legend-review', text: '● 复习' });

    const W = 560, H = 150, pad = 24;
    const max = Math.max(1, ...days.map((d) => Math.max(d.new, d.review)));
    const slot = (W - pad * 2) / days.length;
    const bw = Math.min(10, slot / 3);
    const y = (v: number) => H - 20 - (v / max) * (H - 44);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.addClass('elp-chart-svg');
    const barEl = (x: number, v: number, cls: string) => {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y(v)));
      r.setAttribute('width', String(bw));
      r.setAttribute('height', String(Math.max(0, H - 20 - y(v))));
      r.setAttribute('rx', '2');
      r.setAttribute('class', cls);
      svg.appendChild(r);
    };
    days.forEach((d, i) => {
      const cx = pad + i * slot + slot / 2;
      barEl(cx - bw - 1, d.new, 'elp-bar-new');
      barEl(cx + 1, d.review, 'elp-bar-review');
      if (i % 3 === 0 || i === days.length - 1) {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', String(cx));
        t.setAttribute('y', String(H - 6));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'elp-chart-tick');
        t.textContent = d.date.slice(5);
        svg.appendChild(t);
      }
    });
    panel.appendChild(svg);
  }

  private renderProgressChart(
    parent: HTMLElement,
    days: Array<{ date: string; progressPct?: number }>,
    currentPct: number,
  ): void {
    const panel = parent.createDiv({ cls: 'elp-chart-panel' });
    const head = panel.createDiv({ cls: 'elp-chart-head' });
    head.createSpan({ cls: 'elp-chart-title', text: '学习进度' });
    head.createSpan({ cls: 'elp-chart-now', text: `${currentPct}%` });

    const W = 560, H = 150, pad = 24;
    let last = 0;
    const series = days.map((d) => {
      if (d.progressPct !== undefined) last = d.progressPct;
      return last;
    });
    series[series.length - 1] = Math.max(series[series.length - 1], currentPct);
    const max = Math.max(10, ...series);
    const x = (i: number) => pad + (i / (days.length - 1)) * (W - pad * 2);
    const y = (v: number) => H - 20 - (v / max) * (H - 44);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.addClass('elp-chart-svg');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', series.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(''));
    path.setAttribute('class', 'elp-line-progress');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
    days.forEach((d, i) => {
      if (i % 3 === 0 || i === days.length - 1) {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', String(x(i)));
        t.setAttribute('y', String(H - 6));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'elp-chart-tick');
        t.textContent = d.date.slice(5);
        svg.appendChild(t);
      }
    });
    panel.appendChild(svg);
  }
}
