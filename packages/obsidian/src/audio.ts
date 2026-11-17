/**
 * 发音链：worker Piper TTS（高质量，vault 缓存）→ 浏览器 speechSynthesis 兜底。
 * `pronounce()` 保持同步调用习惯，内部异步完成。
 */

import { normalizePath, requestUrl } from 'obsidian';
import type ElpPlugin from './main';

export interface PronounceOptions {
  /** 本句播放结束时回调（连读驱动）。stop() 打断时不触发。 */
  onEnd?: () => void;
  accent?: 'us' | 'uk';
  rate?: number;
}

// ---------------- browser fallback ----------------

let voiceCache: SpeechSynthesisVoice[] | null = null;

function pickVoice(accent: 'us' | 'uk'): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null;
  if (!voiceCache || voiceCache.length === 0) voiceCache = window.speechSynthesis.getVoices();
  const lang = accent === 'uk' ? 'en-GB' : 'en-US';
  const voices = voiceCache.filter((v) => v.lang === lang || v.lang.startsWith(lang));
  const preferred = voices.find((v) => /premium|enhanced|natural|siri|zoe|samantha/i.test(v.name));
  return preferred ?? voices[0] ?? voiceCache.find((v) => v.lang.startsWith('en')) ?? null;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { voiceCache = null; };
}

function browserSpeak(text: string, opts: PronounceOptions): void {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(opts.accent ?? 'us');
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? (opts.accent === 'uk' ? 'en-GB' : 'en-US');
  u.rate = opts.rate ?? 0.95;
  if (opts.onEnd) u.onend = () => opts.onEnd?.();
  synth.speak(u);
}

// ---------------- worker-backed manager ----------------

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * 单词/短语的合成规范化：孤立的词没有句子韵律，Piper 会读得急促、吞尾音。
 * 补一个句号给足韵律边界，并放慢合成速度（length_scale 1.12）。
 */
function ttsPayload(text: string): { text: string; speed: number } {
  const t = text.trim();
  const isShort = t.split(/\s+/).length <= 2 && t.length <= 30;
  if (isShort && !/[.!?,;:]$/.test(t)) return { text: `${t}.`, speed: 1.12 };
  return { text: t, speed: 1 };
}

/** 是不是"单词/短语"（走词典真人读音）而非整句（走 TTS）。 */
function isWordish(text: string): boolean {
  return text.split(/\s+/).length <= 2 && text.length <= 34 && /^[a-zA-Z][a-zA-Z''\- ]*$/.test(text);
}

let audioCtx: AudioContext | null = null;

/** OpenAI TTS（ChatGPT 朗读同款）。失败返回 null，调用方落回 Piper 链。 */
export async function fetchOpenaiTts(plugin: ElpPlugin, text: string): Promise<ArrayBuffer | null> {
  const { openaiKey, openaiVoice, openaiModel } = plugin.settings;
  if (!openaiKey) return null;
  try {
    const res = await requestUrl({
      url: 'https://api.openai.com/v1/audio/speech',
      method: 'POST',
      headers: { authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: openaiModel || 'gpt-4o-mini-tts',
        voice: openaiVoice || 'nova',
        input: text.slice(0, 2000),
        response_format: 'mp3',
      }),
      throw: false,
    });
    if (res.status === 200 && res.arrayBuffer && res.arrayBuffer.byteLength > 1000) return res.arrayBuffer;
    console.debug('[lexora] openai tts', res.status);
  } catch (e) {
    console.debug('[lexora] openai tts error', e);
  }
  return null;
}

class AudioManager {
  private currentAudio: HTMLAudioElement | null = null;
  private currentSrc: AudioBufferSourceNode | null = null;
  private capsOk: boolean | null = null;
  private capsCheckedAt = 0;

  constructor(private plugin: ElpPlugin) {}

  private cachePath(text: string, speed: number): string {
    const voice = this.plugin.settings.ttsVoice || 'default';
    // speed=1 维持旧 key，整句缓存不作废；慢速单词换新 key，旧的急促版缓存自动失效。
    const key = speed === 1 ? `${voice}|${text}` : `${voice}|s${speed}|${text}`;
    return normalizePath(`${this.plugin.settings.baseFolder}/tts-cache/${hash(key)}.wav`);
  }

  private async workerTtsAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.capsOk !== null && now - this.capsCheckedAt < 60_000) return this.capsOk;
    const caps = await this.plugin.worker.capabilities();
    this.capsOk = !!caps?.features?.tts;
    this.capsCheckedAt = now;
    return this.capsOk;
  }

  /** WebAudio 播放：起播延迟 60ms，避免音频设备唤醒吃掉头音（HTMLAudio 的通病）。 */
  private async play(buf: ArrayBuffer, rate: number, mime = 'audio/wav', onEnd?: () => void): Promise<void> {
    this.stop();
    try {
      audioCtx ??= new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const decoded = await audioCtx.decodeAudioData(buf.slice(0));
      const src = audioCtx.createBufferSource();
      src.buffer = decoded;
      src.playbackRate.value = rate;
      src.connect(audioCtx.destination);
      src.start(audioCtx.currentTime + 0.06);
      src.onended = () => { if (this.currentSrc === src) { this.currentSrc = null; onEnd?.(); } };
      this.currentSrc = src;
      return;
    } catch { /* 解码失败回退 HTMLAudio */ }
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    const audio = new Audio(url);
    audio.playbackRate = rate;
    audio.onended = () => { URL.revokeObjectURL(url); if (this.currentAudio === audio) { this.currentAudio = null; onEnd?.(); } };
    this.currentAudio = audio;
    void audio.play();
  }

  // ---------- 单词：词典真人读音 ----------

  private wordCachePath(word: string, accent: 'us' | 'uk'): string {
    return normalizePath(`${this.plugin.settings.baseFolder}/tts-cache/dict-${accent}-${hash(word)}.mp3`);
  }

  private async fetchDictAudio(word: string, accent: 'us' | 'uk'): Promise<ArrayBuffer | null> {
    try {
      const type = accent === 'uk' ? 1 : 2;
      const res = await requestUrl({
        url: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`,
        throw: false,
      });
      const buf = res.arrayBuffer;
      // 过滤错误页：太小或以 '<' 开头的不是音频
      if (res.status === 200 && buf && buf.byteLength > 800 && new Uint8Array(buf)[0] !== 0x3c) return buf;
    } catch { /* 离线或被墙：走 TTS 兜底 */ }
    return null;
  }

  stop(): void {
    const src = this.currentSrc;
    const audio = this.currentAudio;
    this.currentSrc = null;
    this.currentAudio = null;
    try { src?.stop(); } catch { /* already stopped */ }
    audio?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  async speak(text: string, opts: PronounceOptions): Promise<void> {
    const rate = opts.rate ?? 1;
    const t = text.trim();

    // ---- 单词/短语：优先词典真人读音（旧套件同款），比任何 TTS 都清晰准确 ----
    if (isWordish(t)) {
      const src = this.plugin.settings.wordAudioSource;
      if (src === 'system') { browserSpeak(t, opts); return; }
      if (src === 'dict') {
        try {
          const accent = opts.accent ?? 'us';
          const word = t.toLowerCase();
          const path = this.wordCachePath(word, accent);
          const cached = await this.plugin.storage.readBinary?.(path);
          if (cached) { await this.play(cached, rate, 'audio/mpeg', opts.onEnd); return; }
          const buf = await this.fetchDictAudio(word, accent);
          if (buf) {
            void this.plugin.storage.writeBinary?.(path, buf);
            await this.play(buf, rate, 'audio/mpeg', opts.onEnd);
            return;
          }
        } catch { /* 拿不到词典音 → 走 TTS 链 */ }
      }
    }

    // ---- 句子：OpenAI TTS（选用时）→ worker Piper → 浏览器语音 ----
    if (this.plugin.settings.ttsProvider === 'openai' && this.plugin.settings.openaiKey) {
      try {
        const key = `oai|${this.plugin.settings.openaiModel}|${this.plugin.settings.openaiVoice}|${t}`;
        const path = normalizePath(`${this.plugin.settings.baseFolder}/tts-cache/${hash(key)}.mp3`);
        const cached = await this.plugin.storage.readBinary?.(path);
        if (cached) { await this.play(cached, rate, 'audio/mpeg', opts.onEnd); return; }
        const buf = await fetchOpenaiTts(this.plugin, t);
        if (buf) {
          void this.plugin.storage.writeBinary?.(path, buf);
          await this.play(buf, rate, 'audio/mpeg', opts.onEnd);
          return;
        }
      } catch { /* 落回 Piper 链 */ }
    }
    const p = ttsPayload(t);
    try {
      const cached = await this.plugin.storage.readBinary?.(this.cachePath(p.text, p.speed));
      if (cached) { await this.play(cached, rate, 'audio/wav', opts.onEnd); return; }
      if (await this.workerTtsAvailable()) {
        const buf = await this.plugin.worker.tts(p.text, this.plugin.settings.ttsVoice, p.speed);
        void this.plugin.storage.writeBinary?.(this.cachePath(p.text, p.speed), buf);
        await this.play(buf, rate, 'audio/wav', opts.onEnd);
        return;
      }
    } catch { /* fall through to browser voice */ }
    browserSpeak(text, opts);
  }
}

let manager: AudioManager | null = null;

export function initAudio(plugin: ElpPlugin): void {
  manager = new AudioManager(plugin);
}

/** 停掉当前发音（连读打断用）。 */
export function stopPronounce(): void {
  manager?.stop();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function pronounce(text: string, opts: PronounceOptions = {}): void {
  if (manager) void manager.speak(text, opts);
  else browserSpeak(text, opts);
}
