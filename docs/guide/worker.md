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


## 共享你的 worker（beta）

想让没有 NAS 的朋友直接用你的 worker？v1.2.0 起支持访客 token：

- 访客与站长隔离：**访客不可用 YouTube 相关端点**（那依赖站长的个人 cookies，也属商用红线），转写/切片、TTS 按日限流（默认 10 次任务 / 300 次 TTS，可调）
- 给每位访客发独立 token，随时从列表移除即吊销

```yaml
# docker-compose.yml → environment
- LEXORA_TOKEN=你的管理token          # 站长自己用，全功能
- LEXORA_GUEST_TOKENS=tok-amy,tok-bob  # 访客列表（openssl rand -hex 16 生成）
- LEXORA_PAIRING_WINDOW=0              # 公网部署必关配对
```

### 用 Cloudflare Tunnel 透出（推荐，不开端口、不露家庭 IP）

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels → **Create a tunnel**（Cloudflared 类型），复制 token
2. NAS 上与 worker 同机运行：
   ```bash
   docker run -d --name cloudflared --restart unless-stopped --network host \
     cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <隧道token>
   ```
3. 隧道的 Public Hostname 指向 `http://localhost:8321`（需要一个托管在 Cloudflare 的域名，子域随意，如 `worker.example.com`）
4. 访客在 Lexora 设置里填：服务地址 `https://worker.example.com`、访问 token 填你发的访客 token

::: warning 容量提醒
家用设备的转写并发有限（4 核约 3-5 个并发），适合小范围 beta。正式托管能力请关注官方后续方案。
:::
