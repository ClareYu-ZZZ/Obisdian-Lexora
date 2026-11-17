import { App, Editor, MarkdownFileInfo, MarkdownView, Menu, Modal, Notice, Setting } from 'obsidian';
import type { CardContext, WordEntry } from '@elp/core';
import type ElpPlugin from './main';
import { pronounce } from './audio';
import { iconButton } from './ui';

/** The word under the cursor, or the current selection. */
export function wordAt(editor: Editor): { surface: string; sentence: string } | null {
  const sel = editor.getSelection().trim();
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  if (sel && /^[A-Za-z][A-Za-z''\- ]*$/.test(sel)) {
    return { surface: sel, sentence: sentenceAround(line, cursor.ch) };
  }
  const re = /[A-Za-z][A-Za-z''-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index <= cursor.ch && cursor.ch <= m.index + m[0].length) {
      return { surface: m[0], sentence: sentenceAround(line, m.index) };
    }
  }
  return null;
}

function sentenceAround(line: string, ch: number): string {
  const clean = line.replace(/^[#>\-*\s\d.]+/, '').trim();
  if (clean.length <= 200) return clean;
  const start = Math.max(0, ch - 100);
  return (start > 0 ? '…' : '') + clean.slice(start, start + 200) + '…';
}

/** Register the editor right-click menu. */
export function registerEditorMenu(plugin: ElpPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
      const found = wordAt(editor);
      if (!found) return;
      const surface = found.surface;
      const context: CardContext = {
        sentence: found.sentence,
        sourcePath: view.file?.path ?? undefined,
        sourceTitle: view.file?.basename,
      };
      const collected = plugin.store.findByLemma(surface.toLowerCase());

      if (collected) {
        menu.addItem((item) =>
          item.setTitle(`Lexora：${collected.card.lemma} 已在「${collected.book.name}」`)
            .setIcon('book-open-check')
            .onClick(() => pronounce(collected.card.lemma)),
        );
        menu.addItem((item) =>
          item.setTitle('Lexora：把本句加入例句').setIcon('quote').onClick(async () => {
            const ok = await plugin.store.addContext(collected.card.lemma, context);
            new Notice(ok ? `已加入例句：${collected.card.lemma}` : '这句已经在例句里了');
          }),
        );
        menu.addItem((item) =>
          item.setTitle('Lexora：标记已掌握').setIcon('check').onClick(async () => {
            await plugin.store.setMastered(collected.card.lemma, true);
            plugin.refreshAll();
            new Notice(`已掌握：${collected.card.lemma}`);
          }),
        );
        return;
      }

      menu.addItem((item) => {
        item.setTitle('Lexora：加入单词本').setIcon('book-plus');
        const anyItem = item as unknown as { setSubmenu?: () => Menu };
        if (typeof anyItem.setSubmenu === 'function') {
          const sub = anyItem.setSubmenu();
          for (const book of plugin.store.listBooks()) {
            sub.addItem((si) =>
              si.setTitle(book.name).onClick(() => {
                void quickCollect(plugin, surface, book.id, context);
              }),
            );
          }
          sub.addSeparator();
          sub.addItem((si) =>
            si.setTitle('预览卡片…').onClick(() => {
              new CollectModal(plugin.app, plugin, surface, context).open();
            }),
          );
        } else {
          item.onClick(() => new CollectModal(plugin.app, plugin, surface, context).open());
        }
      });
    }),
  );
}

/** Collect without opening the modal (submenu path). */
async function quickCollect(
  plugin: ElpPlugin, surface: string, bookId: string, context: CardContext,
): Promise<void> {
  const entry = await resolveEntry(plugin, surface);
  if (!entry) {
    new CollectModal(plugin.app, plugin, surface, context).open();
    return;
  }
  const { card, existed } = await plugin.store.collect(bookId, entry, context);
  const bookName = plugin.store.getBook(bookId)?.name ?? '';
  new Notice(existed ? `已存在：${card.lemma}` : `已加入「${bookName}」：${card.lemma}`);
  if (!existed) plugin.eudic.syncLemma(card.lemma);
  if (!existed && plugin.settings.autoPronounce) pronounce(card.lemma);
  plugin.refreshAll();
}

async function resolveEntry(plugin: ElpPlugin, surface: string): Promise<WordEntry | null> {
  if (await plugin.dict.isReady()) {
    const hit = await plugin.dict.lookup(surface);
    if (hit) return hit;
  }
  return null;
}

/** Card preview before saving — mirrors the word-card layout. */
export class CollectModal extends Modal {
  private entry: WordEntry | null = null;
  private bookId: string;
  private manualSenses = '';

  constructor(
    app: App,
    private plugin: ElpPlugin,
    private surface: string,
    private context: CardContext,
  ) {
    super(app);
    this.bookId = plugin.settings.defaultBookId || plugin.store.listBooks()[0]?.id || '';
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass('elp-collect-modal');
    this.entry = await resolveEntry(this.plugin, this.surface);
    this.render();
    if (this.plugin.settings.autoPronounce) pronounce(this.entry?.lemma ?? this.surface);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const lemma = this.entry?.lemma ?? this.surface.toLowerCase();
    const head = contentEl.createDiv({ cls: 'elp-card-head' });
    head.createEl('div', { cls: 'elp-card-word', text: lemma });
    const sub = head.createDiv({ cls: 'elp-card-sub' });
    if (this.entry?.phoneticUS) sub.createSpan({ cls: 'elp-card-phonetic', text: `美 ${this.entry.phoneticUS}` });
    iconButton(sub, 'volume-2', '发音', () => pronounce(lemma));
    if (this.entry?.tags?.length) {
      const tags = head.createDiv({ cls: 'elp-card-tags' });
      for (const t of this.entry.tags) tags.createSpan({ cls: 'elp-tag', text: t });
    }

    if (this.entry) {
      const ul = contentEl.createEl('ul', { cls: 'elp-card-senses' });
      for (const s of this.entry.senses.slice(0, 6)) ul.createEl('li', { text: s });
      if (this.entry.definitionEn?.length) {
        contentEl.createDiv({ cls: 'elp-popover-defen', text: this.entry.definitionEn[0] });
      }
      for (const ex of (this.entry.examples ?? []).slice(0, 2)) {
        const row = contentEl.createDiv({ cls: 'elp-popover-example elp-dict-example' });
        const main = row.createDiv({ cls: 'elp-popover-example-main' });
        main.createDiv({ text: ex.en });
        iconButton(main, 'volume-2', '朗读例句', () => pronounce(ex.en), 'elp-example-speak');
        if (ex.zh) row.createDiv({ cls: 'elp-popover-source', text: ex.zh });
      }
    } else {
      contentEl.createDiv({ cls: 'elp-card-missing', text: '词典中未找到该词，可手动填写释义：' });
      new Setting(contentEl).addTextArea((t) =>
        t.setPlaceholder('n. 释义…').onChange((v) => { this.manualSenses = v; }),
      );
    }

    if (this.context.sentence) {
      const ctx = contentEl.createDiv({ cls: 'elp-card-context' });
      ctx.createDiv({ cls: 'elp-card-context-label', text: '例句（来自当前文档）' });
      ctx.createDiv({ text: this.context.sentence });
    }

    new Setting(contentEl)
      .setName('加入词本')
      .addDropdown((d) => {
        for (const b of this.plugin.store.listBooks()) d.addOption(b.id, b.name);
        if (this.bookId) d.setValue(this.bookId);
        d.onChange((v) => { this.bookId = v; });
      });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('保存').setCta().onClick(async () => {
          const entry: WordEntry = this.entry ?? {
            lemma: this.surface.toLowerCase(),
            phoneticUS: '',
            senses: this.manualSenses.split('\n').map((s) => s.trim()).filter(Boolean),
            tags: [],
            variants: [],
          };
          const { card, existed } = await this.plugin.store.collect(this.bookId, entry, this.context);
          new Notice(existed ? `已存在：${card.lemma}` : `已收录：${card.lemma}`);
          if (!existed) this.plugin.eudic.syncLemma(card.lemma);
          this.plugin.refreshAll();
          this.close();
        }),
      )
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
