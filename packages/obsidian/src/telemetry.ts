/**
 * 更新检查 + 匿名使用统计（都可在设置中关闭）。
 *
 * 隐私模型：
 * - 版本检查只请求 GitHub Releases 公开 API，不携带任何标识。
 * - 统计 ping 每周最多一次：随机安装 ID、插件版本、平台、档位（free/trial/pro）、
 *   粗粒度计数（本月教程数、词本总词数量级）。没有 vault 名、没有笔记内容、没有 key。
 * - TELEMETRY_ENDPOINT 为空时统计完全休眠（不发任何请求）。
 */
import { Notice, Platform, requestUrl } from 'obsidian';
import type ElpPlugin from './main';

/** 接收端（Cloudflare Worker，见 tools/telemetry/）。空字符串 = 统计休眠。 */
export const TELEMETRY_ENDPOINT = '';

const RELEASES_LATEST = 'https://api.github.com/repos/ClareYu-ZZZ/Obsidian-Lexora/releases/latest';
const DAY = 86400_000;

/** 简单 semver 比较：a > b 返回 1。预发布段（-beta.1）按字典序弱比较。 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  const sa = a.split('-')[1] ?? '';
  const sb = b.split('-')[1] ?? '';
  if (sa === sb) return 0;
  if (!sa) return 1;          // 1.0.0 > 1.0.0-beta
  if (!sb) return -1;
  return sa > sb ? 1 : -1;
}

export async function checkForUpdate(plugin: ElpPlugin, manual = false): Promise<void> {
  const s = plugin.settings;
  if (!manual) {
    if (!s.updateCheckEnabled) return;
    if (s.lastUpdateCheckAt && Date.now() - s.lastUpdateCheckAt < DAY) return;
  }
  try {
    const res = await requestUrl({ url: RELEASES_LATEST, throw: false });
    const latest: string | undefined = res.json?.tag_name;
    s.lastUpdateCheckAt = Date.now();
    await plugin.saveSettings();
    if (!latest || res.status !== 200) {
      if (manual) new Notice('检查更新失败，稍后再试');
      return;
    }
    const current = plugin.manifest.version;
    if (cmpVersion(latest, current) > 0) {
      if (manual || s.lastNotifiedVersion !== latest) {
        s.lastNotifiedVersion = latest;
        await plugin.saveSettings();
        new Notice(`Lexora ${latest} 已发布（当前 ${current}）。\n通过 BRAT「Check for updates」即可升级。`, 10000);
      }
    } else if (manual) {
      new Notice(`已是最新版本（${current}）`);
    }
  } catch {
    if (manual) new Notice('检查更新失败，稍后再试');
  }
}

export async function sendTelemetryPing(plugin: ElpPlugin): Promise<void> {
  const s = plugin.settings;
  if (!TELEMETRY_ENDPOINT || !s.telemetryEnabled) return;
  if (s.lastPingAt && Date.now() - s.lastPingAt < 7 * DAY) return;
  try {
    if (!s.installId) {
      s.installId = crypto.randomUUID();
    }
    const books = plugin.store.listBooks?.() ?? [];
    const wordCount = books.reduce((n, b) => n + (b.cards?.length ?? 0), 0);
    const payload = {
      id: s.installId,
      v: plugin.manifest.version,
      platform: Platform.isMobileApp ? 'mobile' : 'desktop',
      tier: plugin.license.tick().tier,
      lessonsThisMonth: s.lessonUsage?.used ?? 0,
      wordMagnitude: wordCount < 100 ? '<100' : wordCount < 1000 ? '<1000' : '1000+',
    };
    s.lastPingAt = Date.now();
    await plugin.saveSettings();
    await requestUrl({
      url: TELEMETRY_ENDPOINT,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify(payload),
      throw: false,
    });
  } catch {
    /* 统计永不打扰用户 */
  }
}
