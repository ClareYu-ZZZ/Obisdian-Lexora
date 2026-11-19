# Lexora

Weave your notes, feeds and media into English lessons — word books, in-note highlighting, rich hover cards and FSRS-powered review.

Lexora 是一个 Obsidian 英语学习插件：订阅（RSS / 播客 / YouTube / 本地媒体 / 文章）→ 一键生成逐句对齐的学习笔记（生词挖掘、长难句、全文分段、音视频切片）→ 独立播放器（视频 / 音频 / 文本三型，区间播放、跟读录音对比、盲听）→ 词本体系（收词、高亮、悬停词卡、欧路双向同步）→ 背单词（FSRS / SM-2 / Leitner，7 种复习模式）→ 统计打卡。

> Status: beta. Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (see below). Not yet in the community plugin directory.

## Install (BRAT beta channel)

1. Install the **BRAT** community plugin in Obsidian.
2. BRAT → *Add beta plugin* → enter `ClareYu-ZZZ/Obsidian-Lexora`.
3. Enable **Lexora** in *Settings → Community plugins*.

BRAT tracks GitHub Releases of this repo (pre-release tags such as `0.16.0-beta.1` are the beta channel) and updates automatically.

## Repository layout

```
packages/core/       Host-agnostic engine: dictionary, word books, mining,
                     subtitles, lesson segmentation, FSRS/SM-2/Leitner review
packages/obsidian/   The Obsidian plugin (@elp/obsidian), bundled with esbuild
services/worker/     Self-hosted companion worker (FastAPI + faster-whisper,
                     Piper TTS, ffmpeg clipping) — Docker image on ghcr
tools/dictgen/       Self-built dictionary pipeline (wordlists → LLM → shards)
scripts/             Dev scripts (test runner)
```

## Development

```bash
npm install            # workspaces: @elp/core + @elp/obsidian
npx tsc --noEmit       # strict type check
node scripts/test.mjs  # core test suite
cd packages/obsidian && node esbuild.config.mjs production   # build main.js
```

Copy `packages/obsidian/{main.js,manifest.json,styles.css}` into `<vault>/.obsidian/plugins/lexora/` to test locally, or use `node esbuild.config.mjs` for watch mode.

## Worker

The optional self-hosted worker provides transcription (faster-whisper), TTS (Piper), media clipping and subtitle/YouTube endpoints.

```bash
curl -fsSLO https://raw.githubusercontent.com/ClareYu-ZZZ/Obsidian-Lexora/main/services/worker/docker-compose.yml
docker compose up -d
docker compose logs | grep 配对码   # pairing code, valid 15 min
```

Then in Obsidian: Lexora settings → companion worker → **Pair…** — enter the host and the 6-digit code; the URL and token are filled in automatically. Auth: loopback requests are unauthenticated; any non-loopback request requires `Authorization: Bearer $LEXORA_TOKEN` (auto-generated and printed on first start if unset).

## Releasing

- **Plugin**: tag the exact manifest version (no `v` prefix): `git tag 0.15.3 && git push origin 0.15.3`. CI builds and attaches `main.js` / `manifest.json` / `styles.css` to the GitHub Release. Tags containing `-` (e.g. `0.16.0-beta.1`) are marked pre-release (BRAT beta). Keep root `manifest.json`, `packages/obsidian/manifest.json` and `versions.json` in sync when bumping.
- **Worker**: bump `services/worker/VERSION` and push to main (CI creates the `worker-v<version>` tag and publishes `<version>` + `latest`), or tag `worker-v<semver>` to publish `ghcr.io/clareyu-zzz/elp-worker:<semver>` + `latest`; pushes to `main` touching `services/worker/**` publish `:edge`.

## Network use disclosure

Lexora makes network requests only for the features you use:

- **Dictionary lookups** (free tier fallback): dictionaryapi.dev, dict.youdao.com
- **Word pronunciation** (dictionary voice source): dict.youdao.com
- **OpenAI TTS** (opt-in, your own API key): api.openai.com
- **Eudic sync** (opt-in, your own token): api.frdic.com
- **Feeds / lessons**: the RSS/podcast/YouTube URLs you subscribe to (plus Invidious instances as a YouTube metadata fallback)
- **Self-hosted worker** (opt-in): the URL you configure
- **Update check** (default on, can be disabled): api.github.com releases endpoint, at most once a day, no identifiers sent
- **Anonymous usage stats** (default on, can be disabled; currently dormant — no endpoint is configured): at most one weekly ping with a random install id, plugin version, platform, tier and coarse counters. Never any note content, vault names or keys. Receiver source: `tools/telemetry/worker.js`

API keys and tokens are stored locally in the plugin's `data.json` and sent only to their own service.

## Pricing model (open core)

All code in this repository is MIT-licensed and the free tier works forever: subscriptions, lesson generation from articles and subtitles, word books, highlighting, hover cards, the bundled self-built dictionary, Eudic sync, and the four basic review modes.

**Lexora Pro** (monthly or yearly subscription — every license key carries an expiry; offline Ed25519 verification, no account, no phone-home) unlocks:
- Worker heavy-compute features: ASR transcription, media clipping, YouTube download
- Advanced review modes: listening, dictation, cloze spelling
- A higher lesson-generation quota: 20 lessons per month (free tier: 5 per month)

Every Pro feature starts a one-time 14-day full-feature trial on first use. The proprietary dictionary data pipeline output (`tools/dictgen/raw`, `out`) is a separate commercial data asset and is not part of this repository or its MIT grant.

## License

MIT — see [LICENSE](LICENSE).
