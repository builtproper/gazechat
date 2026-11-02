/**
 * Video preview engine for GazeChat (GazeChat fork).
 *
 * Stufe 1: poster frame (first frame as a still image).
 * Stufe 2: 2 fps grayscale PNG loop, frame-drop while a BLE send is in flight.
 *
 * The G2 image container is capped at 288x144 and every updateImageRawData
 * costs ~104 ms fixed + ~4 ms/KB — so the loop is throttled by the transport,
 * not by the decoder. Decoding happens on the phone (hidden <video>), only the
 * quantized PNG rides to the glasses.
 */

export const VID_W = 288;
export const VID_H = 144;

export type FrameSender = (img: number[] | string) => Promise<boolean>;

let video: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let objUrl: string | null = null;
let running = false;
let audioOn = false;
let inFlight = false;
let rafId = 0;
let sendFrame: FrameSender | null = null;

function ensureEls(): { v: HTMLVideoElement; c: HTMLCanvasElement } | null {
  if (typeof document === "undefined") return null;
  if (!video) {
    const v = document.createElement("video");
    v.playsInline = true;
    v.muted = true;
    v.preload = "auto";
    Object.assign(v.style, {
      position: "fixed", left: "-9999px", top: "0", width: "1px", height: "1px", opacity: "0",
    } as CSSStyleDeclaration);
    document.body.appendChild(v);
    video = v;
  }
  if (!canvas) {
    const c = document.createElement("canvas");
    c.width = VID_W;
    c.height = VID_H;
    canvas = c;
  }
  return { v: video, c: canvas };
}

/** Cover-fit draw → PNG bytes. The host converts to 4-bit greyscale itself
 *  (imageToGray4), so the old per-pixel getImageData/quantize/putImageData loop
 *  (~165k iterations/frame) was redundant CPU that capped the phone at ~0.7 fps.
 *  ctx.filter does the greyscale natively; if a WebView lacks it the color PNG
 *  still renders (host discards chroma). */
// ── true-grayscale PNG writer (color type 0, 8-bit) ──
// toDataURL emits RGB PNGs (3 bytes/px pre-deflate); gray cuts that to 1.
// Measured: send time tracks PNG size, so a smaller PNG is the lever.
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: number[]): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pngChunk(type: string, data: number[]): number[] {
  const body = [...Array.from(type, (ch) => ch.charCodeAt(0)), ...data];
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}
/** zlib stream via CompressionStream (iOS 16.4+); null if unavailable. */
async function zlibDeflate(raw: Uint8Array): Promise<number[] | null> {
  const CS = (window as any).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([raw.slice().buffer as ArrayBuffer]).stream().pipeThrough(new CS("deflate"));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    return Array.from(buf);
  } catch { return null; }
}
function assembleGrayPng(w: number, h: number, idat: number[]): number[] {
  const ihdr = [...be32(w), ...be32(h), 8, 0, 0, 0, 0]; // 8-bit gray
  return [
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", idat),
    ...pngChunk("IEND", []),
  ];
}

/** PNG-encoded frame (poster AND loop — the only format the host renders). */
async function grabFramePng(c: HTMLCanvasElement): Promise<string | number[] | null> {
  const v = video!;
  if (!v.videoWidth || !v.videoHeight) return null;
  const ctx = c.getContext("2d")!;
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, VID_W, VID_H);
  const scale = Math.max(VID_W / v.videoWidth, VID_H / v.videoHeight);
  const w = v.videoWidth * scale, h = v.videoHeight * scale;
  ctx.drawImage(v, (VID_W - w) / 2, (VID_H - h) / 2, w, h);
  // quantize to the display's 16 gray levels (host is 4-bit anyway)
  const img = ctx.getImageData(0, 0, VID_W, VID_H);
  const d = img.data;
  const gray = new Uint8Array(VID_W * VID_H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = (((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) >> 4) * 17;
  }
  const raw = new Uint8Array(VID_H * (VID_W + 1));
  for (let y = 0; y < VID_H; y++) {
    raw[y * (VID_W + 1)] = 0;
    raw.set(gray.subarray(y * VID_W, (y + 1) * VID_W), y * (VID_W + 1) + 1);
  }
  const idat = await zlibDeflate(raw);
  if (idat) return b64FromBytes(assembleGrayPng(VID_W, VID_H, idat));
  // no CompressionStream (old iOS): RGB toDataURL fallback
  for (let i = 0, p = 0; i < d.length; i += 4, p++) { d[i] = d[i + 1] = d[i + 2] = gray[p]; }
  ctx.putImageData(img, 0, 0);
  // base64 PNG string (documented format) — one field, no 11k-entry JSON array
  return c.toDataURL("image/png").split(",")[1] || "";
}

/** number[] → base64 string without atob/btoa roundtrip gymnastics. */
function b64FromBytes(bytes: number[]): string {
  let bin = "";
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.slice(i, i + CH));
  }
  return btoa(bin);
}

async function pump() {
  if (!running || !sendFrame || !canvas) return;
  if (inFlight) return; // previous send still running → skip this tick
  inFlight = true;
  try {
    const t0 = performance.now();
    const bytes = await grabFramePng(canvas);
    const t1 = performance.now();
    if (bytes) await sendFrame(bytes);
    const t2 = performance.now();
    console.log(`[vidperf] grab ${Math.round(t1 - t0)}ms send ${Math.round(t2 - t1)}ms bytes ${bytes ? bytes.length : 0}`);
  } catch { /* superseded or hiccup: stopLoop ends the loop via running */ }
  inFlight = false;
}

const LOOP_MS = 500; // 2 fps (Joel 02.11.: transport is format-independent —
// the host always expands to the same 20.7KB gray4 buffer, so PNG
// wins on quality; a slower tick just leaves BLE headroom)

/** Load a video blob URL; resolves once the first frame is available. */
export function loadVideo(blobUrl: string): Promise<{ duration: number }> {
  const els = ensureEls();
  if (!els) return Promise.reject(new Error("no DOM"));
  stopLoop();
  if (objUrl) { URL.revokeObjectURL(objUrl); }
  objUrl = blobUrl;
  const v = els.v;
  v.muted = !audioOn;
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve({ duration: v.duration || 0 }); };
    const bad = () => { cleanup(); reject(new Error("video decode failed")); };
    const cleanup = () => { v.removeEventListener("loadeddata", ok); v.removeEventListener("error", bad); };
    v.addEventListener("loadeddata", ok, { once: true });
    v.addEventListener("error", bad, { once: true });
    v.src = blobUrl;
    v.load();
  });
}

/** Single still (poster): seek near the start, grab one frame. */
export async function posterFrame(): Promise<string | number[] | null> {
  const els = ensureEls();
  if (!els || !video) return null;
  const v = video;
  if (v.readyState < 2) await new Promise((r) => { v.addEventListener("loadeddata", r, { once: true }); });
  try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch { /* some sources refuse */ }
  await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 600); });
  return await grabFramePng(els.c);
}

/** Start the ~5 fps loop. The sender must await the actual BLE write. */
export function startLoop(sender: FrameSender) {
  const els = ensureEls();
  if (!els || !video) return;
  sendFrame = sender;
  running = true;
  video.muted = !audioOn;
  if (video.ended) { try { video.currentTime = 0; } catch { /* ignore */ } }
  void video.play().catch(() => { /* autoplay blocked: poster stays */ });
  // PRIMARY tick: the media pipeline itself. iOS clamps setTimeout chains in
  // background/throttled WebViews (phone screen off!) to ~1s — matching the
  // observed ceiling. timeupdate fires from the video decoder (~4Hz) and is
  // not a JS timer, so it survives throttling.
  video.ontimeupdate = () => { if (running) void pump(); };
  // BACKUP tick: covers paused video / sources without timeupdate
  const tick = () => {
    if (!running) return;
    void pump().finally(() => { if (running) rafId = window.setTimeout(tick, LOOP_MS); });
  };
  rafId = window.setTimeout(tick, LOOP_MS);
}

export function stopLoop() {
  running = false;
  sendFrame = null;
  if (video) video.ontimeupdate = null;
  if (rafId) { clearTimeout(rafId); rafId = 0; }
  try { video?.pause(); } catch { /* ignore */ }
}

/** Toggle whether the phone plays the video's audio during preview. */
export function setPreviewAudio(on: boolean) {
  audioOn = on;
  if (video) video.muted = !on;
}
export function getPreviewAudio() { return audioOn; }

export function isPlaying() { return running && !!video && !video.paused; }
export function togglePlay(): boolean {
  if (!video || !running) return false;
  if (video.paused) { void video.play().catch(() => {}); } else { video.pause(); }
  return !video.paused;
}
export function videoTime(): number { return video?.currentTime || 0; }
export { videoTime as videoCurrentTime };
export function unloadVideo() {
  stopLoop();
  if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ } objUrl = null; }
  if (video) { try { video.removeAttribute("src"); video.load(); } catch { /* ignore */ } }
}
