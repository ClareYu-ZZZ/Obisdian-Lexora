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
docker pull ghcr.io/clareyu-zzz/elp-worker:latest
docker run -d --name elp-worker -p 8321:8321 --cpus=4 \
  -e LEXORA_TOKEN=<your-token> -e LEXORA_WHISPER_THREADS=4 \
  ghcr.io/clareyu-zzz/elp-worker:latest
```

Auth: loopback requests are unauthenticated; any non-loopback request requires `Authorization: Bearer $LEXORA_TOKEN` (auto-generated and printed on first start if unset).

## Releasing

- **Plugin**: tag the exact manifest version (no `v` prefix): `git tag 0.15.3 && git push origin 0.15.3`. CI builds and attaches `main.js` / `manifest.json` / `styles.css` to the GitHub Release. Tags containing `-` (e.g. `0.16.0-beta.1`) are marked pre-release (BRAT beta). Keep root `manifest.json`, `packages/obsidian/manifest.json` and `versions.json` in sync when bumping.
- **Worker**: tag `worker-v<semver>` to publish `ghcr.io/clareyu-zzz/elp-worker:<semver>` + `latest`; pushes to `main` touching `services/worker/**` publish `:edge`.

## Pricing model (open core)

All code in this repository is MIT-licensed and the free tier works forever: subscriptions, lesson generation from articles and subtitles, word books, highlighting, hover cards, the bundled self-built dictionary, Eudic sync, and the four basic review modes.

**Lexora Pro** (one license key, offline Ed25519 verification, no account, no phone-home) unlocks:
- Worker heavy-compute features: ASR transcription, media clipping, YouTube download
- Advanced review modes: listening, dictation, cloze spelling

Every Pro feature starts a one-time 14-day full-feature trial on first use. The proprietary dictionary data pipeline output (`tools/dictgen/raw`, `out`) is a separate commercial data asset and is not part of this repository or its MIT grant.

## License

MIT — see [LICENSE](LICENSE).
