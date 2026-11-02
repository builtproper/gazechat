/**
 * Voice-message playback engine for GazeChat.
 *
 * Beeper's API does NOT expose voice-note duration (attachments carry only
 * fileName/fileSize/mimeType/isVoiceNote — verified live 02.11.), so the
 * duration comes from the audio element's loadedmetadata after the fetch.
 *
 * The bar itself is rendered by GlassesUI via the shared videoTransportLine
 * formatter — same look as the video player (▷ 00:00  ▒▒▒▁▁▁  01:23).
 *
 * iOS caveat: WKWebView may refuse to start playback outside a real user
 * gesture; play() rejections are swallowed and the bar simply stays "paused".
 */

let audio: HTMLAudioElement | null = null;
let objUrl: string | null = null;
let msgId: string | null = null;
let dur = 0;
let playing = false;
let ended = false;
let speed = 1;
let ready = false;

export function voiceDur() { return dur; }
export function voicePos() { return audio?.currentTime || 0; }
export function voicePlaying() { return playing; }
export function voiceReady() { return ready; }
export function voiceMsgId() { return msgId; }
export function getVoiceSpeed() { return speed; }

/** Live speed change — applies to the current playback immediately. */
export function setVoiceSpeed(s: number) {
  speed = s;
  if (audio) audio.playbackRate = s;
}

/** Fetch the voice note (caller resolves the authed asset URL), load it
 *  hidden, wait for metadata. Returns false if superseded or failed. */
export async function loadVoice(url: string, id: string, headers?: Record<string, string>): Promise<boolean> {
  unloadVoice();
  msgId = id;
  try {
    const res = await fetch(url, headers ? { headers } : undefined);
    if (!res.ok) return false;
    const blob = await res.blob();
    if (msgId !== id) return false;
    objUrl = URL.createObjectURL(blob);
    const a = new Audio();
    a.preload = "auto";
    a.playbackRate = speed;
    a.addEventListener("loadedmetadata", () => {
      dur = isFinite(a.duration) ? a.duration : 0;
      ready = true;
    });
    a.addEventListener("play", () => { playing = true; });
    a.addEventListener("pause", () => { if (!ended) playing = false; });
    a.addEventListener("ended", () => { playing = false; ended = true; });
    a.src = objUrl;
    audio = a;
    // metadata may already be there (cached blob)
    if (a.readyState >= 1) { dur = isFinite(a.duration) ? a.duration : 0; ready = true; }
    return true;
  } catch {
    return false;
  }
}

/** Tap handler: play / pause / restart-after-end. Returns the new state. */
export function toggleVoice(): "play" | "pause" | "restart" | "none" {
  if (!audio || !ready) return "none";
  if (ended) {
    audio.currentTime = 0;
    ended = false;
    void audio.play().catch(() => {});
    return "restart";
  }
  if (audio.paused) void audio.play().catch(() => {});
  else audio.pause();
  return playing ? "pause" : "play";
}

export function stopVoice() {
  if (audio) { try { audio.pause(); } catch { /* ignore */ } }
  playing = false;
  ended = false;
}

export function unloadVoice() {
  stopVoice();
  if (audio) { try { audio.removeAttribute("src"); } catch { /* ignore */ } }
  if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
  audio = null;
  msgId = null;
  dur = 0;
  ready = false;
}
