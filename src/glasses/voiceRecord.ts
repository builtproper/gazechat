/**
 * Voice recording engine for GazeChat.
 *
 * Tap the mic icon → the input container becomes a recorder: running MM:SS
 * plus a level history of block glyphs (█▇▆▅▄▃▂▁, U+2588..U+2581 — the same
 * set the Volume Meter app uses), pushed 4×/s from the right, pre-filled
 * with the lowest block. PCM chunks arrive from the glasses mic via the
 * EvenHub audioEvent (16 kHz mono 16-bit LE).
 *
 * Second tap → choice screen (send raw voice note vs. transcribe), handled
 * by GlassesUI; this module owns capture, level metering and the WAV/Ogg
 * encoding needed for upload + ASR.
 */

export type RecState = "idle" | "recording" | "choose" | "transcribing" | "review" | "sending";

const PCM_SAMPLE_RATE = 16000;
const BAR_GLYPHS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588"; // ▁▂▃▄▅▆▇█

let state: RecState = "idle";
let chunks: Uint8Array[] = [];
let totalBytes = 0;
let startedAt = 0;
let bars: number[] = []; // level history, 0..7 per slot
let lastLevel = 0; // 0..1 of the newest chunk (for the next push)
let onTick: (() => void) | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

export function recGetState(): RecState { return state; }
export function recSetState(s: RecState) { state = s; }
let frozenSec = 0; // duration at halt (choose/review screens show a frozen MM:SS)

export function recSeconds(): number {
  if (state !== "recording") return frozenSec;
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}
export function recBytes(): number { return totalBytes; }
export function recChunks(): Uint8Array[] { return chunks; }
export function recHasAudio(): boolean { return chunks.length > 0; }

export function fmtMMSS(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** RMS of one 16-bit LE PCM chunk → 0..1 (calibrated like the Volume Meter:
 *  dB = 20*log10(rms/32768) + 85.4, floor ~45 dB → 0, ~90 → 1). */
export function pcmLevel(pcm: Uint8Array): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  const step = Math.max(1, Math.floor(n / 512)); // subsample long chunks
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const v = view.getInt16(i * 2, true);
    sum += v * v;
    count++;
  }
  const rms = Math.sqrt(sum / Math.max(1, count));
  if (rms < 1) return 0;
  const db = 20 * Math.log10(rms / 32768) + 85.4;
  return Math.max(0, Math.min(1, (db - 45) / 45));
}

/** The recorder line for the input container:
 *  "MM:SS ▁▁▂▃▂▁▁ " — time + scrolling level history. */
export function recBarLine(width = 30): string {
  const shown = bars.slice(-width);
  while (shown.length < width) shown.unshift(0);
  return `${fmtMMSS(recSeconds())} ${shown.map((b) => BAR_GLYPHS[b]).join("")}`;
}

/** Push the current level into the history (called 4×/s by the tick). */
function pushBar() {
  bars.push(Math.min(7, Math.round(lastLevel * 7)));
  lastLevel *= 0.6; // decay so a spike doesn't hold the bar up
  if (bars.length > 64) bars = bars.slice(-64);
}

export function recStart(tick: () => void) {
  state = "recording";
  frozenSec = 0;
  chunks = [];
  totalBytes = 0;
  bars = [];
  lastLevel = 0;
  startedAt = Date.now();
  onTick = tick;
  // 8 Hz: push one level slot + refresh the input line
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (state !== "recording") return;
    pushBar();
    onTick?.();
  }, 125);
}

export function recAddChunk(pcm: Uint8Array) {
  if (state !== "recording") return;
  chunks.push(pcm);
  totalBytes += pcm.length;
  const lvl = pcmLevel(pcm);
  if (lvl > lastLevel) lastLevel = lvl;
}

/** Stop capture but KEEP the audio (choose/review screens still need it). */
export function recHalt() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  onTick = null;
  if (startedAt) { frozenSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); }
}

export function recReset() {
  recHalt();
  frozenSec = 0;
  state = "idle";
  chunks = [];
  totalBytes = 0;
  bars = [];
  startedAt = 0;
}

/** Merged PCM (16-bit LE mono 16 kHz). */
export function recMergePcm(): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged;
}

// ── OGG/Opus encoding (WhatsApp voice-note format) ──
// The opus-encdec wasm glue (MIT) ships as a static ES module in
// src/glasses/opus/. Its UMD wrapper was patched once at build time so the
// Emscripten Module object reads globalThis.__OPUS_MOD__ — we prefill that
// with the wasm bytes (imported as a URL asset) before importing the glue,
// so the glue never fetches anything itself. No dynamic code evaluation.
let opusLoader: Promise<{ lib: any; OggOpusEncoder: any }> | null = null;
async function ensureOpus(): Promise<{ lib: any; OggOpusEncoder: any }> {
  if (!opusLoader) {
    opusLoader = (async () => {
      const wasmUrl = (await import("./opus/libopus-encoder.wasm.wasm?url")).default;
      const wasmBytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
      (globalThis as any).__OPUS_MOD__ = { wasmBinary: wasmBytes };
      try {
        // side-effect import: the patched glue assigns globalThis.OpusEncoderLib
        await import("./opus/libopus-encoder.js");
        const { OggOpusEncoder } = await import("./opus/oggOpusEncoder.js");
        const lib = (globalThis as any).OpusEncoderLib;
        if (!lib) throw new Error("OpusEncoderLib missing after import");
        if (!OggOpusEncoder) throw new Error("OggOpusEncoder missing after import");
        if (!lib.isReady) {
          await new Promise<void>((res, rej) => {
            const t = setTimeout(() => rej(new Error("Opus init timeout (5s)")), 5000);
            lib.onready = () => { clearTimeout(t); res(); };
          });
        }
        return { lib, OggOpusEncoder };
      } finally {
        delete (globalThis as any).__OPUS_MOD__;
      }
    })().catch((e) => { opusLoader = null; throw e; });
  }
  return opusLoader;
}

/** int16-LE mono PCM (16 kHz) → OGG/Opus voice-note blob (16 kHz wideband, 32 kbps). */
export async function pcmToOggOpusBlob(pcm: Uint8Array): Promise<Blob> {
  const { lib, OggOpusEncoder } = await ensureOpus();
  const enc = new OggOpusEncoder({
    encoderApplication: 2048, // VoIP — what WhatsApp uses for voice notes
    // encode natively at the mic's 16 kHz (wideband): no pointless up-resample
    // to 48k, and the freed bytes go into the bitrate instead
    encoderSampleRate: PCM_SAMPLE_RATE,
    originalSampleRate: PCM_SAMPLE_RATE,
    numberOfChannels: 1,
    encoderFrameSize: 20,
    maxFramesPerPage: 40,
    encoderBitRate: 32000, // generous for 16 kHz wideband speech
    resampleQuality: 6,
  }, lib);
  const pages: Uint8Array[] = [];
  // copy each page: the muxer reuses its internal segment buffer
  const push = (p: any) => {
    const buf = p?.page ?? p;
    if (buf instanceof Uint8Array && buf.byteLength > 0) pages.push(new Uint8Array(buf));
  };
  push(enc.generateIdPage());
  push(enc.generateCommentPage());
  const f32 = new Float32Array(pcm.length / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < f32.length; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
  const CH = 4800; // 15 × 320-sample frames — whole frames at 16 kHz
  for (let off = 0; off < f32.length; off += CH) {
    const part = f32.subarray(off, off + CH);
    (enc.encode([part]) || []).forEach(push);
  }
  (enc.encodeFinalFrame() || []).forEach(push);
  const blob = new Blob(pages as BlobPart[], { type: "audio/ogg; codecs=opus" });
  if (blob.size < 64) throw new Error(`encoded OGG empty (${blob.size} B)`);
  return blob;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("base64 read failed"));
    r.readAsDataURL(blob);
  });
}
