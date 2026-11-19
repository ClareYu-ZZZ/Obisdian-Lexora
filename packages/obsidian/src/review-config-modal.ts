import { App, Modal, Setting } from 'obsidian';
import { REVIEW_MODE_LABELS, SCHEDULER_LABELS, type ReviewMode, type SchedulerAlgo, type WordBook, isProReviewMode } from '@elp/core';
import type ElpPlugin from './main';

/** Per-book review settings (mirrors the design doc's 复习设置页). */
export class ReviewConfigModal extends Modal {
  constructor(
    app: App,
    private plugin: ElpPlugin,
    private book: WordBook,
    private onDone?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass('elp-config-modal');
    contentEl.createEl('h3', { text: `复习设置 · ${this.book.name}` });

    const cfg = this.book.reviewConfig;
    const save = (patch: Partial<WordBook['reviewConfig']>) =>
      void this.plugin.store.updateReviewConfig(this.book.id, patch);

    new Setting(contentEl)
      .setName('记忆算法')
      .setDesc('FSRS 效果最佳；换算法对已有卡片从下次评分起生效。')
      .addDropdown((d) => {
        for (const [k, v] of Object.entries(SCHEDULER_LABELS)) d.addOption(k, v);
        d.setValue(cfg.algorithm ?? 'fsrs');
        d.onChange((v) => { cfg.algorithm = v as SchedulerAlgo; save({ algorithm: cfg.algorithm }); });
      });

    new Setting(contentEl).setName('复习模式').setDesc('每张卡随机使用一种勾选的模式。').setHeading();
    const modeWrap = contentEl.createDiv({ cls: 'elp-mode-grid' });
    const modes: ReviewMode[] = ['card', 'choice-meaning', 'spelling', 'choice-word', 'listening', 'listening-spell', 'cloze-spell'];
    for (const mode of modes) {
      const btn = modeWrap.createEl('button', {
        cls: 'elp-mode-chip' + (cfg.modes.includes(mode) ? ' is-active' : ''),
        text: REVIEW_MODE_LABELS[mode] + (isProReviewMode(mode) ? ' ⭐' : ''),
      });
      btn.onclick = () => {
        if (isProReviewMode(mode) && !cfg.modes.includes(mode) && !this.plugin.license.ensurePro('review-advanced')) return;
        const set = new Set(cfg.modes);
        if (set.has(mode)) set.delete(mode); else set.add(mode);
        if (set.size === 0) set.add('card');
        cfg.modes = [...set] as ReviewMode[];
        save({ modes: cfg.modes });
        btn.toggleClass('is-active', set.has(mode));
      };
    }

    new Setting(contentEl).setName('例句与发音').setHeading();
    new Setting(contentEl)
      .setName('显示例句')
      .setDesc('在卡片正面显示该词收录时的真实例句。')
      .addToggle((t) => t.setValue(cfg.showExample).onChange((v) => { cfg.showExample = v; save({ showExample: v }); }));
    new Setting(contentEl)
      .setName('随机展示例句')
      .setDesc('每次随机展示不同的例句。')
      .addToggle((t) => t.setValue(cfg.randomExample).onChange((v) => { cfg.randomExample = v; save({ randomExample: v }); }));
    new Setting(contentEl)
      .setName('卡片自动发音')
      .addToggle((t) => t.setValue(cfg.autoPronounce).onChange((v) => { cfg.autoPronounce = v; save({ autoPronounce: v }); }));

    new Setting(contentEl).setName('每日配额').setHeading();
    new Setting(contentEl)
      .setName('每日新词数')
      .addSlider((s) =>
        s.setLimits(5, 100, 5).setDynamicTooltip().setValue(cfg.newPerDay)
          .onChange((v) => { cfg.newPerDay = v; save({ newPerDay: v }); }));
    new Setting(contentEl)
      .setName('每日复习上限')
      .addSlider((s) =>
        s.setLimits(20, 500, 20).setDynamicTooltip().setValue(cfg.reviewsPerDay)
          .onChange((v) => { cfg.reviewsPerDay = v; save({ reviewsPerDay: v }); }));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText('完成').setCta().onClick(() => { this.close(); this.onDone?.(); }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
