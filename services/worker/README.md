# elp-worker

Lexora 的本地伴侣服务：faster-whisper 转写（无字幕媒体 → VTT）。

## NAS 部署（推荐）

```bash
docker build -t elp-worker .
docker run -d --name elp-worker \
  -p 8321:8321 \
  -e LEXORA_TOKEN=换成你的token \
  -e LEXORA_WHISPER_MODEL=small \
  -v elp-models:/root/.cache \
  --restart unless-stopped \
  elp-worker
```

插件设置 → Lexora → 伴侣服务：地址填 `http://<NAS_IP>:8321`，token 同上。

- 非 loopback 请求强制 Bearer token；公网暴露请加反代 TLS 或走 Tailscale。
- 无 GPU 用默认 `small` + int8；M 系列/GPU 可换 `medium`。
- 开发直跑：`pip install -r requirements.txt && uvicorn app:app --port 8321`
- 测试模式：`LEXORA_FAKE=1`（返回固定 VTT，不加载模型）。


## 一键部署（docker compose）

```bash
curl -fsSLO https://raw.githubusercontent.com/ClareYu-ZZZ/Obsidian-Lexora/main/services/worker/docker-compose.yml
docker compose up -d
docker compose logs | grep 配对码
```

然后在 Obsidian：Lexora 设置 → 伴侣服务 → **配对…** → 输入 `http://<主机>:8321` 和日志里的 6 位配对码，地址与 token 自动写入。配对窗口为启动后 15 分钟（`LEXORA_PAIRING_WINDOW` 可调，0 为禁用）；过期后 `docker compose restart` 获取新码。

更新：`docker compose pull && docker compose up -d`。
镜像：`ghcr.io/clareyu-zzz/elp-worker`（`latest` / 版本号 / `edge`，由 `services/worker/VERSION` 驱动发布）。
