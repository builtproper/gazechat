/**
 * Voice recording engine for GazeChat (Joel 03.11.).
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

export type RecState = "idle" | "recording" | "choose" | "transcribing" | "review";

const PCM_SAMPLE_RATE = 16000;
const PCM_BITS_PER_SAMPLE = 16;
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
  chunks = [];
  totalBytes = 0;
  bars = [];
  lastLevel = 0;
  startedAt = Date.now();
  onTick = tick;
  // 4 Hz: push one level slot + refresh the input line
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (state !== "recording") return;
    pushBar();
    onTick?.();
  }, 250);
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

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

/** WAV container (ASR already uses this path). */
export function pcmToWavBlob(pcm: Uint8Array): Blob {
  const headerLength = 44;
  const wavBuffer = new ArrayBuffer(headerLength + pcm.length);
  const view = new DataView(wavBuffer);
  const byteRate = PCM_SAMPLE_RATE * 1 * (PCM_BITS_PER_SAMPLE / 8);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, PCM_BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.length, true);
  new Uint8Array(wavBuffer, headerLength).set(pcm);
  return new Blob([wavBuffer], { type: "audio/wav" });
}

// ── OGG/Opus encoding (WhatsApp voice-note format) ──
// Bundled via Vite (dynamic import → separate lazy chunk, wasm asset URL
// resolved by the bundler — no runtime path guessing). MIT: opus-encdec.
let opusLoader: Promise<{ lib: any; OggOpusEncoder: any }> | null = null;
async function ensureOpus(): Promise<{ lib: any; OggOpusEncoder: any }> {
  if (!opusLoader) {
    opusLoader = (async () => {
      // the glue reads this at module-init → must be set BEFORE the import
      (window as any).OPUS_SCRIPT_LOCATION = "/opus/";
      // @ts-ignore — untyped wasm glue from opus-encdec
      const libMod = await import("opus-encdec/dist/libopus-encoder.wasm.js");
      // @ts-ignore
      const oggMod = await import("opus-encdec/src/oggOpusEncoder.js");
      const lib = (libMod.default ?? libMod) as any;
      const OggOpusEncoder = (oggMod.OggOpusEncoder ?? oggMod.default?.OggOpusEncoder ?? oggMod.default) as any;
      if (!lib || typeof lib._opus_encoder_create !== "function") throw new Error("OpusEncoderLib missing");
      if (!lib.isReady) await new Promise<void>((res) => { lib.onready = () => res(); });
      if (!OggOpusEncoder) throw new Error("OggOpusEncoder missing");
      return { lib, OggOpusEncoder };
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
  const push = (p: any) => { if (p?.page) pages.push(p.page); };
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
  return new Blob(pages as BlobPart[], { type: "audio/ogg; codecs=opus" });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("base64 read failed"));
    r.readAsDataURL(blob);
  });
}
