import type { FeedConfig } from '@elp/core';
import { makeId } from '@elp/core';
import type ElpPlugin from './main';

interface FeedsFile {
  feeds: FeedConfig[];
  /** feed item id -> lesson note path (已生成标记) */
  generated: Record<string, string>;
}

export class FeedsStore {
  private data: FeedsFile = { feeds: [], generated: {} };

  constructor(private plugin: ElpPlugin) {}

  private get path(): string {
    return this.plugin.settings.feedsFile;
  }

  async load(): Promise<void> {
    const raw = await this.plugin.storage.readText(this.path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as FeedsFile;
        this.data = { feeds: parsed.feeds ?? [], generated: parsed.generated ?? {} };
      } catch { /* keep defaults */ }
    }
  }

  private async save(): Promise<void> {
    await this.plugin.storage.writeText(this.path, JSON.stringify(this.data, null, 2));
  }

  list(): FeedConfig[] {
    return this.data.feeds;
  }

  async add(feed: Omit<FeedConfig, 'id'>): Promise<FeedConfig> {
    const full: FeedConfig = { id: makeId('feed'), ...feed };
    this.data.feeds.push(full);
    await this.save();
    return full;
  }

  async remove(id: string): Promise<void> {
    this.data.feeds = this.data.feeds.filter((f) => f.id !== id);
    await this.save();
  }

  lessonFor(itemId: string): string | undefined {
    return this.data.generated[itemId];
  }

  async markGenerated(itemId: string, lessonPath: string): Promise<void> {
    this.data.generated[itemId] = lessonPath;
    await this.save();
  }

  /** 删除教程后清掉指向该目录的标记，按钮恢复为「生成教程」。 */
  async unmarkByPath(dir: string): Promise<void> {
    let changed = false;
    for (const [k, v] of Object.entries(this.data.generated)) {
      if (v === dir || v.startsWith(dir + '/')) {
        delete this.data.generated[k];
        changed = true;
      }
    }
    if (changed) await this.save();
  }
}
