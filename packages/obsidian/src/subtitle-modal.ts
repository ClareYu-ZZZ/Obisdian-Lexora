import { App, FuzzySuggestModal, TFile } from 'obsidian';
import type ElpPlugin from './main';

/** 选择 vault 内的字幕文件（.vtt/.srt）。 */
export class SubtitlePickModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private plugin: ElpPlugin, private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder('选择字幕文件（.vtt / .srt）——用你已有的字幕或自托管服务获取');
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === 'vtt' || f.extension === 'srt');
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onPick(f); }
}
