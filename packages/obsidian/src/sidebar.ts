import { ItemView, MarkdownView, TFile, WorkspaceLeaf, debounce } from 'obsidian';
import { scan, type MatchInfo } from '@elp/core';
import type ElpPlugin from './main';
import { pronounce } from './audio';
import { iconButton } from './ui';

export const SIDEBAR_VIEW_TYPE = 'elp-word-list';

interface Row {
  lemma: string;
  surface: string;
  offset: number;
  info: MatchInfo;
}

/** Right sidebar: every collected word found in the active note. */
export class WordListView extends ItemView {
  private rows: Row[] = [];
  private filePath: string | null = null;
  private scheduled = debounce(() => void this.refresh(), 400, true);

  constructor(leaf: WorkspaceLeaf, private plugin: ElpPlugin) {
    super(leaf);
  }

  getViewType(): string { return SIDEBAR_VIEW_TYPE; }
  getDisplayText(): string { return '生词列表'; }
  getIcon(): string { return 'book-a'; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduled()));
    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f.path === this.filePath) this.scheduled();
    }));
    await this.refresh();
  }

  /** Called by the plugin after any index change. */
  requestRefresh(): void {
    this.scheduled();
  }

  async refresh(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    this.filePath = file?.path ?? null;
    this.rows = [];
    if (file instanceof TFile && file.extension === 'md' && this.plugin.index.size > 0) {
      const text = await this.app.vault.cachedRead(file);
      const seen = new Set<string>();
      for (const hit of scan(text, this.plugin.index)) {
        if (seen.has(hit.info.lemma)) continue;
        seen.add(hit.info.lemma);
        this.rows.push({ lemma: hit.info.lemma, surface: hit.text, offset: hit.start, info: hit.info });
      }
    }
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('elp-sidebar');

    const counts = { new: 0, learning: 0, mastered: 0 };
    for (const r of this.rows) counts[r.info.status]++;

    const header = root.createDiv({ cls: 'elp-sidebar-header' });
    const titleRow = header.createDiv({ cls: 'elp-sidebar-title-row' });
    titleRow.createSpan({ cls: 'elp-sidebar-title', text: '本文生词' });
    titleRow.createSpan({ cls: 'elp-sidebar-count', text: String(this.rows.length) });
    if (this.rows.length) {
      const statRow = header.createDiv({ cls: 'elp-sidebar-stats' });
      const stat = (cls: string, label: string, n: number) => {
        const s = statRow.createSpan({ cls: 'elp-sidebar-stat' });
        s.createSpan({ cls: `elp-dot elp-dot-${cls}` });
        s.createSpan({ text: `${label} ${n}` });
      };
      stat('new', '未学习', counts.new);
      stat('learning', '学习中', counts.learning);
      stat('mastered', '已掌握', counts.mastered);
    }

    if (this.rows.length === 0) {
      root.createDiv({ cls: 'elp-sidebar-empty', text: this.filePath ? '当前文档没有已收录的词。' : '打开一篇笔记查看生词。' });
      return;
    }

    const list = root.createDiv({ cls: 'elp-sidebar-list' });
    for (const row of this.rows) {
      const hit = this.plugin.store.findByLemma(row.lemma);
      const item = list.createDiv({ cls: 'elp-sidebar-item' });
      item.onclick = () => void this.revealInEditor(row);

      const top = item.createDiv({ cls: 'elp-sidebar-item-top' });
      top.createSpan({ cls: `elp-dot elp-dot-${row.info.status}` });
      top.createSpan({ cls: 'elp-sidebar-lemma', text: row.lemma });
      if (hit?.card.phoneticUS) {
        top.createSpan({ cls: 'elp-sidebar-phonetic', text: hit.card.phoneticUS });
      }
      const actions = top.createDiv({ cls: 'elp-sidebar-actions' });
      iconButton(actions, 'volume-2', '发音', () => pronounce(row.lemma));
      iconButton(
        actions,
        row.info.status === 'mastered' ? 'rotate-ccw' : 'check',
        row.info.status === 'mastered' ? '取消已掌握' : '标记已掌握',
        async () => {
          await this.plugin.store.setMastered(row.lemma, row.info.status !== 'mastered');
          this.plugin.refreshAll();
        },
      );

      const sense = hit?.card.senses[0] ?? '';
      if (sense) item.createDiv({ cls: 'elp-sidebar-sense', text: sense });
    }
  }

  private async revealInEditor(row: Row): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.filePath ?? '');
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const pos = view.editor.offsetToPos(row.offset);
    view.editor.setCursor(pos);
    view.editor.scrollIntoView({ from: pos, to: pos }, true);
  }
}
