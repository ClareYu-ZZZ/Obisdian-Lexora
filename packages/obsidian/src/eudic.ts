import { Notice, requestUrl } from 'obsidian';
import type { WordEntry } from '@elp/core';
import type ElpPlugin from './main';

/**
 * 欧路词典开放 API（my.eudic.net/openapi）生词本同步客户端。
 * 只做"把词推到欧路生词本"这一件事，不读取欧路词库内容（合规边界）。
 */

const BASE = 'https://api.frdic.com/api/open/v1';

export interface EudicCategory {
  id: string;
  name: string;
}

export class EudicClient {
  constructor(private plugin: ElpPlugin) {}

  get configured(): boolean {
    const s = this.plugin.settings;
    return !!(s.eudicToken && s.eudicCategoryId);
  }

  private headers(): Record<string, string> {
    return {
      authorization: this.plugin.settings.eudicToken,
      'content-type': 'application/json',
    };
  }

  /** 拉取用户的英语生词本列表。 */
  async listCategories(): Promise<EudicCategory[]> {
    const res = await requestUrl({
      url: `${BASE}/studylist/category?language=en`,
      headers: this.headers(),
      throw: false,
    });
    if (res.status === 401 || res.status === 403) throw new Error('token 无效或已过期');
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const data = (res.json as { data?: Array<{ id: string | number; name: string }> }).data ?? [];
    return data.map((c) => ({ id: String(c.id), name: c.name }));
  }

  /** 拉取某欧路生词本的全部单词（自动翻页）。 */
  async listWords(categoryId: string): Promise<string[]> {
    const words: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const res = await requestUrl({
        url: `${BASE}/studylist/words/${categoryId}?language=en&page=${page}&page_size=100`,
        headers: this.headers(),
        throw: false,
      });
      if (res.status === 401 || res.status === 403) throw new Error('token 无效或已过期');
      if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.text?.slice(0, 100)}`);
      const data = (res.json as { data?: Array<string | { word?: string }> }).data ?? [];
      const batch = data
        .map((it) => (typeof it === 'string' ? it : it.word ?? ''))
        .map((w) => w.trim().toLowerCase())
        .filter((w) => /^[a-z][a-z''\- ]*$/.test(w));
      if (batch.length === 0) break;
      words.push(...batch);
      if (batch.length < 100) break;
    }
    return [...new Set(words)];
  }

  /** 把欧路生词本导入为 Lexora 本地词本（同名复用）。 */
  async importCategory(category: EudicCategory): Promise<void> {
    const notice = new Notice(`拉取欧路「${category.name}」…`, 0);
    try {
      const words = await this.listWords(category.id);
      if (words.length === 0) { notice.hide(); new Notice('这个生词本是空的'); return; }

      let book = this.plugin.store.listBooks().find((b) => b.name === category.name);
      if (!book) book = await this.plugin.store.createBook(category.name);

      const dictReady = await this.plugin.dict.isReady();
      let added = 0, existed = 0;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (i % 25 === 0) notice.setMessage(`导入中 ${i}/${words.length}…`);
        if (this.plugin.store.isCollected(w)) { existed++; continue; }
        let entry: WordEntry | null = null;
        if (dictReady) entry = await this.plugin.dict.lookup(w);
        if (!entry) entry = { lemma: w, phoneticUS: '', senses: [], tags: [], variants: [] };
        // eslint-disable-next-line no-await-in-loop
        await this.plugin.store.collect(book.id, entry);
        added++;
      }
      this.plugin.refreshAll();
      notice.setMessage(`已导入「${category.name}」：新增 ${added}，已在其他词本 ${existed}`);
      window.setTimeout(() => notice.hide(), 5000);
    } catch (e) {
      notice.hide();
      new Notice(`导入失败：${(e as Error).message}`);
    }
  }

  /** 在欧路创建新生词本，返回新词本。 */
  async createCategory(name: string): Promise<EudicCategory> {
    const res = await requestUrl({
      url: `${BASE}/studylist/category`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ language: 'en', name }),
      throw: false,
    });
    if (res.status === 401 || res.status === 403) throw new Error('token 无效或已过期');
    if (res.status >= 400) {
      throw new Error(
        `HTTP ${res.status}: ${res.text?.slice(0, 120)}（欧路服务端拒绝；换个名字重试，或在欧路 App 里建好后点「拉取词本列表」）`,
      );
    }
    const data = (res.json as { data?: { id?: string | number; name?: string } }).data ?? {};
    if (data.id !== undefined) return { id: String(data.id), name: data.name ?? name };
    // 部分版本创建成功但不回 id：重新拉列表找同名
    const cats = await this.listCategories();
    const hit = cats.find((c) => c.name === name);
    if (!hit) throw new Error('创建成功但未找到新词本，请点「拉取词本列表」');
    return hit;
  }

  /** 推送单词到指定生词本。兼容两种官方接口形态。 */
  async addWords(words: string[]): Promise<void> {
    const s = this.plugin.settings;
    if (!this.configured || words.length === 0) return;
    // 形态 A：POST /studylist/words/{id}?language=en {words}
    let res = await requestUrl({
      url: `${BASE}/studylist/words/${s.eudicCategoryId}?language=en`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ words }),
      throw: false,
    });
    if (res.status === 404 || res.status === 405) {
      // 形态 B：POST /studylist/words {id, language, words}
      res = await requestUrl({
        url: `${BASE}/studylist/words`,
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ id: s.eudicCategoryId, language: 'en', words }),
        throw: false,
      });
    }
    if (res.status === 401 || res.status === 403) throw new Error('token 无效或已过期');
    if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.text?.slice(0, 120)}`);
  }

  /** 收词后的静默同步（失败只提示一次，不打断流程）。 */
  syncLemma(lemma: string): void {
    if (!this.plugin.settings.eudicAutoSync || !this.configured) return;
    void this.addWords([lemma]).catch((e: Error) => {
      new Notice(`欧路同步失败（${lemma}）：${e.message}`);
    });
  }

  /** 整本词本批量推送（每批 50 词）。 */
  async pushBook(bookId: string): Promise<void> {
    const book = this.plugin.store.getBook(bookId);
    if (!book) { new Notice('词本不存在'); return; }
    if (!this.configured) { new Notice('先在设置里配置欧路 token 和目标生词本'); return; }
    const lemmas = book.cards.map((c) => c.lemma);
    if (lemmas.length === 0) { new Notice('词本是空的'); return; }
    const notice = new Notice('推送到欧路…', 0);
    try {
      for (let i = 0; i < lemmas.length; i += 50) {
        notice.setMessage(`推送到欧路 ${Math.min(i + 50, lemmas.length)}/${lemmas.length}…`);
        // eslint-disable-next-line no-await-in-loop
        await this.addWords(lemmas.slice(i, i + 50));
      }
      notice.setMessage(`已推送 ${lemmas.length} 词到欧路「${this.plugin.settings.eudicCategoryName}」`);
      window.setTimeout(() => notice.hide(), 4000);
    } catch (e) {
      notice.hide();
      new Notice(`推送失败：${(e as Error).message}`);
    }
  }
}
