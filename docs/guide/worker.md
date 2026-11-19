# 伴侣服务（elp-worker）

worker 是可选的自托管服务，承担插件做不了的重活：

- **faster-whisper 转写**：无字幕的播客 / 本地媒体 → 逐句字幕（Pro）
- **ffmpeg 切片**：教程段落的原声 mp3 切片（Pro）
- **YouTube 下载**：720p 视频 / 音轨（Pro）
- **Piper TTS**：本地免费语音合成（免费档可用）

没有 worker 时，文章教程、带字幕的媒体、词库、复习等功能照常工作。

## 一键部署

在 NAS 或任意常开的机器上（需要 Docker）：

```bash
curl -fsSLO https://raw.githubusercontent.com/ClareYu-ZZZ/Obsidian-Lexora/main/services/worker/docker-compose.yml
docker compose up -d
docker compose logs | grep 配对码
```

## 配对

启动后 15 分钟内，在 Obsidian：**Lexora 设置 → 伴侣服务 → 配对…**，输入 `http://<主机IP>:8321` 和日志里的 6 位配对码——地址与访问 token 自动写入，并立即做一次能力检查。

- 窗口过期后 `docker compose restart` 可获取新配对码
- 想固定 token，在 compose 的 environment 里设置 `LEXORA_TOKEN`
- 配对端点可用 `LEXORA_PAIRING_WINDOW=0` 禁用

## 更新与版本

```bash
docker compose pull && docker compose up -d
```

镜像：`ghcr.io/clareyu-zzz/elp-worker`（`latest` / 语义化版本 / `edge`）。

## 安全模型

- 同机（loopback）请求免鉴权；任何局域网请求必须带 Bearer token
- 不要把 8321 端口直接暴露公网；外出访问建议 Tailscale / WireGuard，或反向代理加 TLS
- YouTube 下载依赖浏览器导出的 `cookies.txt`（放到容器 `/app/cookies.txt`），过期需重新导出
