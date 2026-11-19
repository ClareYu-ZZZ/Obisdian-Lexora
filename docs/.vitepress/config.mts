import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'Lexora',
  description: '把订阅、笔记与音视频织成英语课 —— Obsidian 英语学习插件',
  base: '/Obsidian-Lexora/',
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: 'GitHub', link: 'https://github.com/ClareYu-ZZZ/Obsidian-Lexora' },
    ],
    sidebar: [
      {
        text: '指南',
        items: [
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '伴侣服务（worker）', link: '/guide/worker' },
          { text: 'Lexora Pro 与订阅', link: '/guide/pro' },
          { text: '常见问题', link: '/guide/faq' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/ClareYu-ZZZ/Obsidian-Lexora' }],
    footer: { message: 'MIT Licensed', copyright: '© 2026 Lexora' },
  },
});
