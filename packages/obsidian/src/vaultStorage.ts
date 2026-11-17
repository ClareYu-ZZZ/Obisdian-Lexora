import { normalizePath, type Vault } from 'obsidian';
import type { StorageAdapter } from '@elp/core';

/** StorageAdapter backed by the Obsidian vault adapter (works on mobile). */
export class VaultStorage implements StorageAdapter {
  constructor(private vault: Vault) {}

  async readText(path: string): Promise<string | null> {
    const p = normalizePath(path);
    try {
      if (!(await this.vault.adapter.exists(p))) return null;
      return await this.vault.adapter.read(p);
    } catch {
      return null;
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    const p = normalizePath(path);
    await this.mkdir(p.split('/').slice(0, -1).join('/'));
    await this.vault.adapter.write(p, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.vault.adapter.exists(normalizePath(path));
  }

  async list(folder: string): Promise<string[]> {
    const p = normalizePath(folder);
    try {
      if (!(await this.vault.adapter.exists(p))) return [];
      const listed = await this.vault.adapter.list(p);
      return listed.files.map((f) => f.split('/').pop() ?? f);
    } catch {
      return [];
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const p = normalizePath(path);
    try {
      if (!(await this.vault.adapter.exists(p))) return null;
      return await this.vault.adapter.readBinary(p);
    } catch {
      return null;
    }
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const p = normalizePath(path);
    await this.mkdir(p.split('/').slice(0, -1).join('/'));
    await this.vault.adapter.writeBinary(p, data);
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    try {
      if (await this.vault.adapter.exists(p)) await this.vault.adapter.remove(p);
    } catch { /* ignore */ }
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (!p || p === '/' || p === '.') return;
    const parts = p.split('/');
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.vault.adapter.exists(cur))) {
        // eslint-disable-next-line no-await-in-loop
        await this.vault.adapter.mkdir(cur).catch(() => { /* raced */ });
      }
    }
  }
}
