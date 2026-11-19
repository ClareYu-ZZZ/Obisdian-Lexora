# 常见问题

## 录音没有声音 / 报错

- **macOS**：Obsidian 需要先拿到系统麦克风授权——设置 → 核心插件 → 启用「录音机」并开始一次录音触发系统弹窗 → 允许 → 重启 Obsidian
- **iOS / Android**：首次录音会弹系统授权；如果误点了拒绝，去系统设置里给 Obsidian 打开麦克风权限
- 桌面端录音存为 `.webm`，手机端为 `.m4a`，互相都能回放

## YouTube 字幕 / 下载失败

- 字幕抓取优先官方字幕，失败时走 Invidious 兜底；都失败可用 worker 转写（Pro）
- worker 下载 YouTube 需要容器里有有效的 `cookies.txt`（从浏览器导出），过期会 403——重新导出并 `docker cp cookies.txt elp-worker:/app/cookies.txt`

## 手机连不上 worker

手机必须与 worker 同一局域网（同 WiFi）。外出想用，推荐 Tailscale：NAS 和手机都装上后，worker 地址填 Tailscale IP 即可。

## 旧教程的段落 ▶ 只播第一句

v0.13.6 之前生成的教程没有段落区间信息，重新生成该教程即可修复。

## 词卡没有某个词 / 释义不对

自建词库覆盖约 1.1 万常用词（CET4/6、考研、雅思、托福、GRE 词表并集）；之外的词走在线词典兜底。发现释义问题欢迎提 issue。

## 额度什么时候重置？

教程生成额度按自然月计算，每月 1 日重置；只有**成功生成**才计数，失败不扣。

## 数据与隐私

- 所有学习数据（词本、复习记录、录音、教程）都是 vault 里的本地文件
- 无遥测、无账号；API key / token 只存本机 `data.json`
- 网络请求仅发生在你使用对应功能时（详见仓库 README 的 Network use disclosure）
