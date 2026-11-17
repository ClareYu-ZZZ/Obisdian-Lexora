import { FuzzySuggestModal, Notice, TFile } from 'obsidian';
import type { WordEntry } from '@elp/core';
import type ElpPlugin from './main';

/** Import known-words.txt → mastered set. */
export async function importKnownWords(plugin: ElpPlugin): Promise<void> {
  const path = plugin.settings.knownWordsPath;
  if (!path) { new Notice('先在设置中填写 known-words.txt 路径'); return; }
  const raw = await plugin.storage.readText(path);
  if (raw == null) { new Notice(`读不到文件：${path}`); return; }
  const words = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const added = await plugin.store.importMastered(words);
  plugin.refreshAll();
  new Notice(`已导入 ${added} 个已掌握词（共 ${words.length} 行）`);
}

/** Pick a .canvas wordbook and import its cards' head words. */
export function importCanvas(plugin: ElpPlugin): void {
  const canvases = plugin.app.vault.getFiles().filter((f) => f.extension === 'canvas');
  if (canvases.length === 0) { new Notice('vault 中没有 .canvas 文件'); return; }
  new CanvasPicker(plugin, canvases).open();
}

class CanvasPicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin: ElpPlugin, private files: TFile[]) {
    super(plugin.app);
    this.setPlaceholder('选择要导入的 Canvas 词本');
  }
  getItems(): TFile[] { return this.files; }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { void importFromCanvasFile(this.plugin, f); }
}

/** Extract the head word of a canvas text node (markdown-tolerant). */
export function headWordOf(nodeText: string): string | null {
  const firstLine = nodeText.split('\n').find((l) => l.trim()) ?? '';
  const stripped = firstLine.replace(/[#>*_`~[\]()]/g, ' ').trim();
  const m = stripped.match(/^([A-Za-z][A-Za-z''-]*(?:\s[A-Za-z][A-Za-z''-]*){0,3})/);
  if (!m) return null;
  const candidate = m[1].trim().toLowerCase();
  return candidate.length >= 2 ? candidate : null;
}

async function importFromCanvasFile(plugin: ElpPlugin, file: TFile): Promise<void> {
  const raw = await plugin.app.vault.cachedRead(file);
  let nodes: Array<{ type?: string; text?: string }> = [];
  try { nodes = (JSON.parse(raw).nodes ?? []) as typeof nodes; }
  catch { new Notice('Canvas 文件解析失败'); return; }

  const words = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'text' || !n.text) continue;
    const w = headWordOf(n.text);
    if (w) words.add(w);
  }
  if (words.size === 0) { new Notice('没有从 Canvas 中识别出单词'); return; }

  const bookId = plugin.settings.defaultBookId || plugin.store.listBooks()[0]?.id;
  if (!bookId) { new Notice('没有可用的单词本'); return; }
  const bookName = plugin.store.getBook(bookId)?.name ?? '';

  const dictReady = await plugin.dict.isReady();
  let added = 0, existed = 0, missing = 0;
  for (const w of words) {
    if (plugin.store.isCollected(w)) { existed++; continue; }
    let entry: WordEntry | null = null;
    if (dictReady) entry = await plugin.dict.lookup(w);
    if (!entry) {
      // Keep single unknown tokens out; keep phrases (they're intentional).
      if (!w.includes(' ')) { missing++; continue; }
      entry = { lemma: w, phoneticUS: '', senses: [], tags: [], variants: [] };
    }
    const res = await plugin.store.collect(bookId, entry, { sourcePath: file.path, sentence: '' });
    if (res.existed) existed++; else added++;
  }
  plugin.refreshAll();
  new Notice(`Canvas 导入「${bookName}」：新增 ${added}，已存在 ${existed}，词典未收录跳过 ${missing}`);
}
