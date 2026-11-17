import { App, Modal, Setting, setIcon } from 'obsidian';

/** Lucide icon button, consistent across popover/sidebar/review views. */
export function iconButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: (ev: MouseEvent) => void,
  cls = '',
): HTMLButtonElement {
  const btn = parent.createEl('button', {
    cls: `elp-icon-btn ${cls}`.trim(),
    attr: { 'aria-label': label, title: label },
  });
  setIcon(btn, icon);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick(ev);
  });
  return btn;
}

/** Render a sentence with every occurrence of the lemma/variants emphasized. */
export function renderSentence(
  parent: HTMLElement, sentence: string, lemma: string, variants: string[],
): void {
  const forms = new Set([lemma.toLowerCase(), ...variants.map((v) => v.toLowerCase())]);
  const re = /[A-Za-z][A-Za-z''-]*/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence))) {
    if (!forms.has(m[0].toLowerCase())) continue;
    if (m.index > pos) parent.appendText(sentence.slice(pos, m.index));
    parent.createSpan({ cls: 'elp-em', text: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < sentence.length) parent.appendText(sentence.slice(pos));
}

export const STATUS_LABEL: Record<string, string> = {
  new: '未学习',
  learning: '学习中',
  mastered: '已掌握',
};


/** Electron 里 window.prompt 不可用，用这个替代。 */
export class TextInputModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private title: string,
    initial: string,
    private onSubmit: (value: string) => void,
    private placeholder = '',
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    this.contentEl.createEl('h3', { text: this.title });
    const input = this.contentEl.createEl('input', {
      cls: 'elp-text-input',
      attr: { type: 'text', placeholder: this.placeholder },
    });
    input.value = this.value;
    input.addEventListener('input', () => { this.value = input.value; });
    const submit = () => {
      const v = this.value.trim();
      if (!v) return;
      this.close();
      this.onSubmit(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('确定').setCta().onClick(submit))
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
    window.setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  onClose(): void { this.contentEl.empty(); }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private ctaText: string,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl('h3', { text: this.title });
    this.contentEl.createEl('p', { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.ctaText).setWarning().onClick(() => { this.close(); this.onConfirm(); }))
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
  }

  onClose(): void { this.contentEl.empty(); }
}
