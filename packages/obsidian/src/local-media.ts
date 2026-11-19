import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from 'obsidian';
import type ElpPlugin from './main';
import { generateFromMedia } from './generate';
import { SubtitlePickModal } from './subtitle-modal';

const MEDIA_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'mp3', 'm4a', 'wav', 'ogg', 'flac']);

/** 命令入口：从本地媒体生成教程（有字幕用字幕，无字幕走服务转写）。 */
export function pickLocalMedia(plugin: ElpPlugin): void {
  const files = plugin.app.vault.getFiles().filter((f) => MEDIA_EXT.has(f.extension.toLowerCase()));
  if (files.length === 0) { new Notice('vault 中没有音视频文件'); return; }
  new MediaPickModal(plugin.app, files, (media) => void onMediaPicked(plugin, media)).open();
}

class MediaPickModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private files: TFile[], private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder('选择本地音视频文件');
  }
  getItems(): TFile[] { return this.files; }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onPick(f); }
}

function findSidecarSubtitle(plugin: ElpPlugin, media: TFile): TFile | null {
  const folder = media.parent?.path ?? '';
  const prefix = media.basename.toLowerCase();
  const subs = plugin.app.vault.getFiles().filter((f) =>
    (f.extension === 'vtt' || f.extension === 'srt') &&
    (f.parent?.path ?? '') === folder &&
    f.basename.toLowerCase().startsWith(prefix),
  );
  return subs[0] ?? null;
}

async function onMediaPicked(plugin: ElpPlugin, media: TFile): Promise<void> {
  const sidecar = findSidecarSubtitle(plugin, media);
  if (sidecar) {
    await generateFromMedia(plugin, {
      title: media.basename,
      media: { kind: 'local', path: media.path },
      subtitleFile: sidecar,
    });
    return;
  }
  new SubtitleSourceModal(plugin, media).open();
}

/** 无同名字幕时：选字幕文件，或走 elp-worker 转写。 */
class SubtitleSourceModal extends Modal {
  constructor(private plugin: ElpPlugin, private media: TFile) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `${this.media.name} 没有同名字幕` });

    new Setting(contentEl)
      .setName('选择 vault 中的字幕文件')
      .addButton((b) => b.setButtonText('选择 .vtt / .srt').onClick(() => {
        this.close();
        new SubtitlePickModal(this.app, this.plugin, (sub) => {
          void generateFromMedia(this.plugin, {
            title: this.media.basename,
            media: { kind: 'local', path: this.media.path },
            subtitleFile: sub,
          });
        }).open();
      }));

    const caps = await this.plugin.worker.capabilities();
    const transcribeRow = new Setting(contentEl)
      .setName('用本地服务转写（faster-whisper）')
      .setDesc(caps?.features.transcribe
        ? `已连接 ${caps.name}（whisper ${caps.models?.whisper ?? ''}）`
        : '未连接伴侣服务：设置 → Lexora → 伴侣服务 填好地址后可用');
    transcribeRow.addButton((b) => {
      b.setButtonText('开始转写').setCta().onClick(() => void this.transcribe());
      if (!caps?.features.transcribe) b.setDisabled(true);
    });
  }

  private async transcribe(): Promise<void> {
    if (!this.plugin.license.ensurePro('worker-advanced')) return;
    this.close();
    const notice = new Notice('上传媒体并转写中…', 0);
    try {
      const vtt = await this.plugin.worker.transcribe(this.media, (status, progress) => {
        notice.setMessage(status === 'running'
          ? `转写中 ${(progress * 100).toFixed(0)}%…`
          : '排队中…');
      });
      const subPath = `${this.media.parent?.path ?? ''}/${this.media.basename}.en.vtt`.replace(/^\//, '');
      const existing = this.plugin.app.vault.getAbstractFileByPath(subPath);
      const subFile = existing instanceof TFile
        ? (await this.plugin.app.vault.modify(existing, vtt), existing)
        : await this.plugin.app.vault.create(subPath, vtt);
      notice.hide();
      new Notice(`字幕已保存：${subPath}`);
      await generateFromMedia(this.plugin, {
        title: this.media.basename,
        media: { kind: 'local', path: this.media.path },
        subtitleFile: subFile,
      });
    } catch (e) {
      notice.hide();
      new Notice(`转写失败：${(e as Error).message}`);
    }
  }

  onClose(): void { this.contentEl.empty(); }
}
