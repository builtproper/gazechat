/**
 * Video preview engine for GazeChat (GazeChat fork).
 *
 * Stufe 1: poster frame (first frame as a still image).
 * Stufe 2: ~5 fps grayscale loop, frame-drop while a BLE send is in flight.
 *
 * The G2 image container is capped at 288x144 and every updateImageRawData
 * costs ~104 ms fixed + ~4 ms/KB — so the loop is throttled by the transport,
 * not by the decoder. Decoding happens on the phone (hidden <video>), only the
 * quantized PNG rides to the glasses.
 */

export const VID_W = 288;
export const VID_H = 144;

export type FrameSender = (pngBytes: number[]) => Promise<void>;

let video: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let objUrl: string | null = null;
let running = false;
let audioOn = false;
let inFlight = false;
let wantFrame = false;
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

/** Cover-fit draw + 4-bit quantization (same palette trick as the avatar strip). */
function grabFrame(c: HTMLCanvasElement): number[] | null {
  const v = video!;
  if (!v.videoWidth || !v.videoHeight) return null;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, VID_W, VID_H);
  const scale = Math.max(VID_W / v.videoWidth, VID_H / v.videoHeight);
  const w = v.videoWidth * scale, h = v.videoHeight * scale;
  ctx.drawImage(v, (VID_W - w) / 2, (VID_H - h) / 2, w, h);
  const img = ctx.getImageData(0, 0, VID_W, VID_H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255) * 15) * 17;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL("image/png");
  return Array.from(atob(url.split(",")[1] || ""), (ch) => ch.charCodeAt(0));
}

async function pump() {
  if (!running || !sendFrame || !canvas) return;
  if (inFlight) { wantFrame = true; return; } // drop while BLE is busy
  inFlight = true;
  try {
    const bytes = grabFrame(canvas);
    if (bytes) await sendFrame(bytes);
  } catch { /* transport hiccup: keep looping */ }
  inFlight = false;
  if (running && wantFrame) { wantFrame = false; scheduleNext(); }
}

function scheduleNext() {
  const v = video!;
  // requestVideoFrameCallback fires per DECODED frame (iOS Safari 15.4+);
  // fallback: timeupdate (~4 Hz) or a plain interval
  if (typeof (v as any).requestVideoFrameCallback === "function") {
    (v as any).requestVideoFrameCallback(() => { void pump(); });
  } else {
    rafId = window.setTimeout(() => { void pump(); scheduleNext(); }, 180);
  }
}

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
export async function posterFrame(): Promise<number[] | null> {
  const els = ensureEls();
  if (!els || !video) return null;
  const v = video;
  if (v.readyState < 2) await new Promise((r) => { v.addEventListener("loadeddata", r, { once: true }); });
  try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch { /* some sources refuse */ }
  await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 600); });
  return grabFrame(els.c);
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
  scheduleNext();
}

export function stopLoop() {
  running = false;
  wantFrame = false;
  sendFrame = null;
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
