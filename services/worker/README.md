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
