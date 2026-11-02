/**
 * GazeChat - Glasses UI Component
 *
 * Optimized for Even G2 display: 576x288 pixels
 * Uses full width for maximum readability.
 */

import {
  BeeperAccount,
  BeeperChat,
  BeeperClient,
  BeeperMessage,
  formatMessageText,
} from "../services/beeperClient";
import { DisplayLine, GlassAction, GlassNavState } from "even-toolkit/types";
import {
  activateKeepAlive,
  deactivateKeepAlive,
} from "even-toolkit/keep-alive";
import { mapGlassEvent } from "even-toolkit/action-map";
import { buildStaticActionBar } from "even-toolkit/action-bar";
import { bindKeyboard } from "even-toolkit/keyboard";
import { useCallback, useEffect, useState, useRef } from "react";

import { buildHeaderLine } from "even-toolkit/text-utils";
import { line } from "even-toolkit/types";
import { useGlasses } from "even-toolkit/useGlasses";
import {
  CreateStartUpPageContainer,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { getServiceIcon } from "./platformIcons";
import {
  pngDataUrlToBytes,
  normalizePlatform,
} from "./platformImages";
import type { SpeechApiConfig } from "../services";
import { getApiConfig } from "../services/config";
import {
  loadVideo, posterFrame, startLoop, stopLoop, unloadVideo,
  setPreviewAudio, videoCurrentTime, VID_W, VID_H,
} from "./videoPreview";
import {
  loadVoice, toggleVoice, unloadVoice, stopVoice,
  voiceDur, voicePos, voicePlaying, voiceMsgId,
  setVoiceSpeed,
} from "./voicePreview";
import { imgLayout as imgLayoutFor, renderImageSlices } from "./imagePreview";

// ═══════════════════════════════════════════════════════════════
// DISPLAY CONSTANTS
// ═══════════════════════════════════════════════════════════════

// Even G2: 576px wide, ~288px tall
// Font: 22px Courier New monospace (~12px per char)
// Visible width: ~48 chars, but leaving padding, use 40 chars
const DISPLAY_WIDTH = 60; // Max characters per line
const DISPLAY_LINES = 8; // Max lines on Even G2 display (288px / ~40px per line)
const STICKY_FOOTER_LINES = 2; // separator + bottom action/menu line
const SEPARATOR_LINE = "----------------------------------------"; // 40 dashes
const GLASSES_DISPLAY_WIDTH = 576;
const GLASSES_DISPLAY_HEIGHT = 288;
const MESSAGE_MEDIA_IMAGE_WIDTH = 200;
const MESSAGE_MEDIA_IMAGE_HEIGHT = 100;
const MESSAGE_MEDIA_IMAGE_X = Math.floor(
  (GLASSES_DISPLAY_WIDTH - MESSAGE_MEDIA_IMAGE_WIDTH) / 2,
);
const MESSAGE_MEDIA_IMAGE_Y = 0;
const ENABLE_CUSTOM_GLASSES_RENDERER = true;
const STARTUP_DELAY_MS = 1200; // Brief delay so OS registers the startup render
const DEFAULT_BEEPER_BASE_URL = "http://localhost:23373";

const BASE_PAGE_CONTAINER = {
  OVERLAY_ID: 1,
  OVERLAY_NAME: "overlay",
  TEXT_ID: 2,
  TEXT_NAME: "main-text",
  CHAT_IMAGE_ID: 3,
  CHAT_IMAGE_NAME: "chat-icons",
} as const;

// Storage key for persisting state (using Even SDK storage)
const STORAGE_KEY = "even-messages-state";

// Saved state interface
interface SavedState {
  selectedAccount: string | null;
  selectedChat: string | null;
  chatScrollPosition?: number;
}

// Bridge instance for storage
let bridgeInstance: EvenAppBridge | null = null;

async function getBridge(): Promise<EvenAppBridge | null> {
  if (bridgeInstance) return bridgeInstance;
  try {
    bridgeInstance = await waitForEvenAppBridge();
    return bridgeInstance;
  } catch (e) {
    console.warn("[GlassesUI] Failed to get bridge:", e);
    return null;
  }
}

// ASCII indicators (safe for glasses font)
const ICONS = {
  SELECTED: ">",
  BACK: "<",
  UNREAD: "[!",
};

// Quick reply presets (2 columns x 4 rows = 8 replies)
const QUICK_REPLIES = [
  "Voice",
  "Got it",
  "OK",
  "Thanks!",
  "See you",
  "On way",
  "Call me",
  "Busy",
  "Later",
];

const QUICK_REPLY_CANCEL = "Cancel";
const VOICE_NOT_CONFIGURED_STATUS = "Speech not configured in Settings";
const MESSAGE_LOADING_HINT_DELAY_MS = 3000;
const VOICE_MIC_UNAVAILABLE_STATUS = "Mic unavailable";
const VOICE_TRANSCRIPTION_FAILED_STATUS = "Transcription failed";
const VOICE_SENDING_STATUS = "Sending...";
const VOICE_SEND_FAILED_STATUS = "Send failed - click to retry";
const MESSAGE_DETAIL_REBUILD_MAX_CHARS = 950;
const MESSAGE_DETAIL_UPGRADE_MAX_CHARS = 2000;
const NATIVE_OVERLAY_EVENT_DEBOUNCE_MS = 250;
const PCM_SAMPLE_RATE = 16000;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_CHANNELS = 1;

const NATIVE_REPLY_CONTAINER = {
  QUICK_TITLE_ID: 201,
  QUICK_LIST_ID: 202,
  VOICE_CARD_ID: 211,
  VOICE_SEND_ID: 212,
  QUICK_TITLE_NAME: "reply-title",
  QUICK_LIST_NAME: "reply-list",
  VOICE_CARD_NAME: "voice-card",
  VOICE_SEND_NAME: "voice-send",
} as const;

const MESSAGE_DETAIL_CONTAINER = {
  TEXT_ID: 221,
  TEXT_NAME: "message-detail-text",
  IMAGE_ID: 223,
  IMAGE_NAME: "message-media",
  ACTION_LIST_ID: 222,
  ACTION_LIST_NAME: "message-detail-actions",
} as const;

type MessageDetailImageTile = {
  messageId: string;
  url: string;
  bytes: Uint8Array;
};

type MessageDetailImageStatus = "none" | "loading" | "loaded" | "failed";

type MessageAttachmentRecord = NonNullable<
  BeeperMessage["attachments"]
>[number] &
  Record<string, unknown>;

const messageMediaImageCache = new Map<string, Uint8Array>();
const failedMessageMediaImageUrls = new Set<string>();

// ═══════════════════════════════════════════════════════════════
// PERSISTENCE (Using Even SDK Storage)
// ═══════════════════════════════════════════════════════════════

async function loadSavedState(): Promise<SavedState> {
  try {
    const bridge = await getBridge();
    if (bridge) {
      const saved = await bridge.getLocalStorage(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    }
    // Fallback to browser localStorage for development
    const fallback = localStorage.getItem(STORAGE_KEY);
    if (fallback) {
      return JSON.parse(fallback);
    }
  } catch (e) {
    console.warn("[GlassesUI] Failed to load saved state:", e);
  }
  return { selectedAccount: null, selectedChat: null };
}

const AUDIO_PREF_KEY = "gc_vidaudio";
async function persistAudioPref(on: boolean): Promise<void> {
  try {
    const bridge = await getBridge();
    if (bridge) { await bridge.setLocalStorage(AUDIO_PREF_KEY, on ? "1" : "0"); return; }
  } catch { /* fall through */ }
  try { localStorage.setItem(AUDIO_PREF_KEY, on ? "1" : "0"); } catch { /* ignore */ }
}
const SPEED_PREF_KEY = "gc_vspeed";
async function persistSpeedPref(v: number): Promise<void> {
  try {
    const bridge = await getBridge();
    if (bridge) { await bridge.setLocalStorage(SPEED_PREF_KEY, String(v)); return; }
  } catch { /* fall through */ }
  try { localStorage.setItem(SPEED_PREF_KEY, String(v)); } catch { /* ignore */ }
}
async function loadSpeedPref(): Promise<number> {
  try {
    const bridge = await getBridge();
    if (bridge) { const v = Number(await bridge.getLocalStorage(SPEED_PREF_KEY)); return [0.5, 1, 1.5, 2].includes(v) ? v : 1; }
  } catch { /* fall through */ }
  try { const v = Number(localStorage.getItem(SPEED_PREF_KEY)); return [0.5, 1, 1.5, 2].includes(v) ? v : 1; } catch { return 1; }
}
async function loadAudioPref(): Promise<boolean> {
  try {
    const bridge = await getBridge();
    if (bridge) { const v = await bridge.getLocalStorage(AUDIO_PREF_KEY); return v === "1"; }
  } catch { /* fall through */ }
  try { return localStorage.getItem(AUDIO_PREF_KEY) === "1"; } catch { return false; }
}

async function saveState(state: SavedState): Promise<void> {
  try {
    const bridge = await getBridge();
    if (bridge) {
      await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(state));
      return;
    }
  } catch (e) {
    console.warn("[GlassesUI] SDK storage failed, using fallback:", e);
  }
  // Fallback to browser localStorage for development
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("[GlassesUI] Failed to save state:", e);
  }
}

// Strip emoji and other unsupported Unicode characters for glasses display
// Glasses only support basic Latin, numbers, punctuation, and common symbols
function stripUnsupportedChars(text: string): string {
  // HTML/entity sanitizing first (some Beeper bridges deliver raw HTML)
  text = sanitizeHtmlAndEntities(text)
  // Emoji are passed through: the G2 firmware renders the common ones
  // (verified on device: 😀 ❤). Unknown glyphs are skipped by the firmware.
  return text
    .replace(/[\u{1F000}-\u{1F02F}]/gu, "") // Mahjong tiles
    .replace(/[\u{1F0A0}-\u{1F0FF}]/gu, "") // Playing cards
    .replace(/[\u{1F700}-\u{1F77F}]/gu, "") // Alchemical symbols
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, "") // zero-width / bidi marks
}

// Sanitize HTML markup and entities that some channels deliver verbatim.
function sanitizeHtmlAndEntities(text: string): string {
  let t = text
  // line-break tags
  t = t.replace(/<br\s*\/?>/gi, "\n")
  t = t.replace(/<\/?p[^>]*>/gi, "\n")
  // <a href="url">label</a> → label, else url (max 100 chars, scheme stripped)
  t = t.replace(
    /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]*>/g, "").trim()
      if (l) return l
      const clean = href.replace(/^https?:\/\//i, "").replace(/^www\./i, "")
      return clean.length > 100 ? clean.slice(0, 100) + "…" : clean
    },
  )
  // bare long URLs → trim to 100 chars (scheme stripped) for readability
  t = t.replace(/https?:\/\/\S{101,}/gi, (u) => {
    const clean = u.replace(/^https?:\/\//i, "")
    return clean.slice(0, 100) + "…"
  })
  // all remaining tags (<strong>, <em>, <font>, ...) are dropped, content kept
  t = t.replace(/<[^>]+>/g, "")
  // entities (&amp; LAST to avoid double-decoding)
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
  // collapse 3+ newlines, trim trailing spaces per line
  t = t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n")
  return t
}

// Helper: create a separator line (using meta style so text renders)
function sep(): DisplayLine {
  return line(SEPARATOR_LINE, "meta");
}

// Own messages often arrive with a raw bridge address like "@user:beeper.com"
// as senderName — show a friendly "Me" instead.
function senderLabel(msg: { isSender?: boolean; senderName?: string; senderID?: string }): string {
  const name = (msg.senderName || "").trim()
  if (msg.isSender || /^@[^:]+:beeper\.com$/i.test(name) || /^@[^:]+:beeper\.com$/i.test(msg.senderID || "")) {
    return "Me"
  }
  return name
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

type Screen = "startup" | "accounts" | "chats" | "messages" | "quickReply" | "voiceReply" | "messageDetail";

interface AppState {
  accounts: BeeperAccount[];
  chats: BeeperChat[];
  messages: BeeperMessage[];
  currentScreen: Screen;
  selectedAccount: string | null;
  selectedChat: string | null;
  selectedMessageIndex: number;
  highlightedIndex: number;
  isLoading: boolean;
  messageLoadingTimedOut: boolean;
  messageLoadFailed: boolean;
  setupRequired: boolean;
  messageScrollOffset: number; // For scrolling through messages
  messageDetailScrollOffset: number;
  messageDetailImageTile: MessageDetailImageTile | null;
  messageDetailImageStatus: MessageDetailImageStatus;
  demoMode: boolean; // Easter egg: force demo mode with fake data
  voiceStatus: string | null;
  voiceTranscript: string;
  voiceAudioBytes: number;
  startupTick: number; // drives the loading-box dot animation
}

interface TranscriptionResponse {
  text?: string;
}

// Demo mode trigger: 5 clicks within 1 second
const DEMO_MODE_CLICKS = 5;
const DEMO_MODE_WINDOW_MS = 1000;

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

// Glasses display is ~40 chars wide at default font

function padRight(text: string, len: number): string {
  while (text.length < len) text += " ";
  return text.slice(0, len);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 2) + "..";
}

// Truncate name: show first word + first letter of second word (if any)
function truncateName(text: string, max: number): string {
  if (text.length <= max) return text;

  const words = text.split(" ");
  if (words.length === 1) {
    return words[0].slice(0, max);
  }

  // First word + first letter of second word
  const first = words[0];
  const second = words[1] ? words[1][0] : "";
  const result = `${first} ${second}`.trim();

  return result.slice(0, max);
}

// ── Pixel-accurate text metrics (G2 font is proportional) ──────────────────
// Measured glyph widths (calibrated on real G2 firmware, KM app). Unknown
// chars fall back to 11.7 (wide average) — safe overestimate for layout.
import GLYPHS from "../glyphs.json";
const RAW_GLYPHS: Record<string, number> = {};
for (const [k, v] of Object.entries(GLYPHS)) if (typeof v === "number") RAW_GLYPHS[k] = v;
const GLYPH_W: Record<string, number> = {
  ...RAW_GLYPHS,
  "1": 6.4, ":": 3.7, g: 10.7, r: 6.9, V: 12.8, K: 10.8, " ": 6.0,
  "ä": 10.8, "ö": 9.8, "ü": 10.8, "ß": 9.8, "Ä": 12.8, "Ö": 11.7, "Ü": 11.7,
  "|": 5.0, "▏": 20.0, "[": 6.5, "]": 6.5, "‹": 8.0, "›": 8.0, "…": 16.0,
};
const glyphW = (c: string) => GLYPH_W[c] ?? (c === " " ? 6 : c.codePointAt(0)! > 0x2600 ? 16 : 11.7);
const textPx = (t: string): number => [...t].reduce((s, c) => s + glyphW(c), 0);

// Truncate to a pixel budget (adds '…' when cut).
function truncatePx(text: string, maxPx: number): string {
  if (textPx(text) <= maxPx) return text;
  let out = "";
  let w = 0;
  const ell = glyphW("…");
  for (const c of text) {
    if (w + glyphW(c) + ell > maxPx) break;
    out += c;
    w += glyphW(c);
  }
  return out + "…";
}

// Pad with spaces so the string occupies at least targetPx (proportional-safe).
function padPx(text: string, targetPx: number): string {
  let out = text;
  let w = textPx(out);
  while (w < targetPx && out.length < 60) {
    out += " ";
    w += glyphW(" ");
  }
  return out;
}

// Convert ASCII to fullwidth for consistent rendering on G2 proportional font.
// The glasses firmware uses a proportional font where ASCII characters have
// varying widths. CJK fullwidth characters are all the same width, so
// converting display text ensures column alignment works correctly.
// See: https://github.com/nickustinov/even-g2-notes/blob/main/docs/display.md
function toFullwidth(str: string): string {
  return str.replace(/[\x20-\x7E]/g, (ch) =>
    ch === " " ? "\u3000" : String.fromCharCode(ch.charCodeAt(0) + 0xfee0),
  );
}

// Calculate the scroll position to show maximum messages while keeping the bottom visible
function getMessagePreview(msg: BeeperMessage): string {
  const content = stripUnsupportedChars(formatMessageText(msg));
  // Flatten newlines for single-line preview
  return content.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ");
}

// Word-wrap text to fit within maxWidth, breaking words as needed
// date tag above the time for older messages:
// today → none; ≤7 days → Mon/Tue/…; ≤1 year → TT.MM.; older → TT.MM.JJ
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function msgDateTag(timestamp: string): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ageDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (ageDays <= 0) return "";
  if (ageDays <= 7) return DAY_NAMES[d.getDay()];
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  if (ageDays > 365) return `${dd}.${mm}.${String(d.getFullYear()).slice(-2)}`;
  return `${dd}.${mm}.`;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp)
    .toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })
    .slice(0, 5);
}

function getVisibleChatWindow(
  chats: BeeperChat[],
  highlightedIdx: number,
): { start: number; visible: BeeperChat[] } {
  const maxItems = 9; // full-height list container: 284px / ~28px per line (KM fits 10)
  const maxStart = Math.max(0, chats.length - maxItems);
  const start = Math.max(0, Math.min(maxStart, highlightedIdx - 1));

  return {
    start,
    visible: chats.slice(start, start + maxItems),
  };
}

function wrapText(text: string, maxWidth: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > maxWidth) {
      let breakAt = remaining.lastIndexOf(" ", maxWidth);
      if (breakAt <= 0) {
        breakAt = maxWidth;
      }
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    lines.push(remaining);
  }

  return lines.length > 0 ? lines : [""];
}

function getMessageDetailWrappedBody(msg: BeeperMessage): string[] {
  const body = stripUnsupportedChars(formatMessageText(msg));
  return wrapText(body, DISPLAY_WIDTH - 2);
}

function normalizeBeeperBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BEEPER_BASE_URL).replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

function getAttachmentString(
  attachment: MessageAttachmentRecord,
  key: string,
): string | null {
  const value = attachment[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function buildBeeperAssetUrl(baseUrl: string, assetUrl: string): string {
  if (!assetUrl) return "";

  if (assetUrl.startsWith("/")) {
    return `${normalizeBeeperBaseUrl(baseUrl)}${assetUrl}`;
  }

  if (assetUrl.startsWith("mxc://") || /^https?:\/\//i.test(assetUrl)) {
    return `${normalizeBeeperBaseUrl(baseUrl)}/v1/assets/serve?url=${encodeURIComponent(assetUrl)}`;
  }

  // Beeper stores avatars as local file paths (file:///... or C:\...). The
  // HTTP API serves them through the same asset route; the reverse proxy
  // whitelists /v1/assets/serve for images.
  if (/^(file:\/\/|[a-zA-Z]:[\\/])/i.test(assetUrl)) {
    return `${normalizeBeeperBaseUrl(baseUrl)}/v1/assets/serve?url=${encodeURIComponent(assetUrl)}`;
  }

  return assetUrl;
}

function isImageAttachment(
  msg: BeeperMessage,
  attachment: MessageAttachmentRecord,
): boolean {
  const messageType = String(msg.type || "").toUpperCase();
  const attachmentType = getAttachmentString(attachment, "type")?.toUpperCase();
  const mimeType = getAttachmentString(attachment, "mimeType")?.toLowerCase();
  const filename = getAttachmentString(attachment, "filename")?.toLowerCase();

  return (
    messageType === "IMAGE" ||
    messageType === "STICKER" ||
    attachmentType === "IMAGE" ||
    attachmentType === "STICKER" ||
    !!mimeType?.startsWith("image/") ||
    !!filename?.match(/\.(apng|avif|gif|jpe?g|png|webp)$/)
  );
}

function getAttachmentImageUrl(
  attachment: MessageAttachmentRecord,
  baseUrl: string,
): string | null {
  const rawUrl =
    getAttachmentString(attachment, "srcURL") ||
    getAttachmentString(attachment, "srcUrl") ||
    getAttachmentString(attachment, "url") ||
    getAttachmentString(attachment, "thumbnailUrl") ||
    getAttachmentString(attachment, "thumbnailURL") ||
    getAttachmentString(attachment, "thumbnail_srcURL");

  return rawUrl ? buildBeeperAssetUrl(baseUrl, rawUrl) : null;
}

function getMessageImageUrl(
  msg: BeeperMessage,
  baseUrl?: string,
): string | null {
  const attachments = msg.attachments as MessageAttachmentRecord[] | undefined;
  if (!attachments?.length) {
    return null;
  }

  const normalizedBaseUrl = normalizeBeeperBaseUrl(baseUrl);
  for (const attachment of attachments) {
    if (!isImageAttachment(msg, attachment)) {
      continue;
    }

    const imageUrl = getAttachmentImageUrl(attachment, normalizedBaseUrl);
    if (imageUrl) {
      return imageUrl;
    }
  }

  return null;
}

async function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

async function loadMessageMediaImageBytes(url: string): Promise<Uint8Array> {
  if (failedMessageMediaImageUrls.has(url)) {
    throw new Error(`Skipping previously failed image: ${url}`);
  }

  const cached = messageMediaImageCache.get(url);
  if (cached) {
    return cached;
  }

  try {
    const img = await loadImageElement(url);
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error("Image decoded without dimensions");
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not get canvas context");
    }

    canvas.width = MESSAGE_MEDIA_IMAGE_WIDTH;
    canvas.height = MESSAGE_MEDIA_IMAGE_HEIGHT;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const scale = Math.min(
      canvas.width / img.naturalWidth,
      canvas.height / img.naturalHeight,
    );
    const drawWidth = Math.max(1, Math.round(img.naturalWidth * scale));
    const drawHeight = Math.max(1, Math.round(img.naturalHeight * scale));
    const drawX = Math.floor((canvas.width - drawWidth) / 2);
    const drawY = Math.floor((canvas.height - drawHeight) / 2);

    ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    const bytes = new Uint8Array(pngDataUrlToBytes(canvas.toDataURL("image/png")));
    messageMediaImageCache.set(url, bytes);
    return bytes;
  } catch (e) {
    failedMessageMediaImageUrls.add(url);
    throw e;
  }
}

function buildGlassesText(lines: DisplayLine[], fullwidth = true): string {
  const text = lines
    .map((entry) => {
      if (entry.style === "separator") {
        return "─".repeat(44);
      }
      if (entry.style === "inverted" || entry.inverted) {
        return `▶ ${entry.text}`;
      }
      return `  ${entry.text}`;
    })
    .join("\n");
  // Fullwidth conversion keeps manually-padded columns aligned on the
  // proportional G2 font; the chat list skips it (pixel metrics instead).
  return fullwidth ? toFullwidth(text) : text;
}

// ── spine image: "GazeChat" wordmark (user-provided art, pre-rotated to
// 33×144 grayscale PNG, imported as data URL and shipped as raw bytes) ──────
import SPINE_PNG from "../assets/gazechat-spine.png";
let chatProbeDone = false; // one-time API field probe (avatar/preview?)
let spineBytes: number[] | null = null;
async function getSpineBytes(): Promise<number[]> {
  if (spineBytes) return spineBytes;
  const res = await fetch(SPINE_PNG);
  const blob = await res.blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  spineBytes = Array.from(buf);
  return spineBytes;
}


// ── avatar strip composer ───────────────────────────────────────────────────
// Renders one page of chat avatars into a vertical strip: grayscale avatar
// with the messenger icon (top-right) and unread badge (bottom-right) baked
// in. Media comes from Beeper /v1/assets/serve (token-authenticated); on any
// failure we draw the chat initials instead so the layout never breaks.
const AV = 56; // avatar cell width
const AVH = 54; // cell height: 2px under 2 text lines (bottom alignment, user 31.10.)

// Media-only chats carry no preview text; Beeper's preview object also lacks
// the message type, so we fetch the last message once per chat (cached) and
// label the preview with Photo/Video/Audio/Voice/File.
const mediaTypeCache = new Map<string, string>();
async function getMediaLabel(chat: any, client: any): Promise<string> {
  const hit = mediaTypeCache.get(chat.id);
  if (hit !== undefined) return hit;
  let label = "";
  try {
    const res = await client.listMessages(chat.id, { limit: 1 });
    const m = res?.messages?.[0];
    const t = (m?.type || "").toUpperCase();
    // no space after the emoji: the firmware skips glyphs it lacks (📷🎬🎵🎤)
    // and the leftover space then showed as a leading blank in the preview
    if (t === "IMAGE") label = "📷Photo";
    else if (t === "VIDEO") label = "🎬Video";
    else if (t === "AUDIO") label = "🎵Audio";
    else if (t === "VOICE") label = "🎤Voice Message";
    else if (t === "FILE") label = "📎Attachment";
    else if (t === "STICKER") label = "Sticker";
    else if (t === "LOCATION") label = "Location";
    else if (t === "REACTION") {
      // "Reacted 👍 to: <original>" — the emoji lives on the LINKED message
      // (reactions[]); the reaction message itself only carries the link.
      // listMessages returns the newest page first, so the original is in it.
      const linked = (res?.messages || []).find((x: any) => x.id === m.linkedMessageID);
      const rs = Array.isArray((linked as any)?.reactions) ? (linked as any).reactions : [];
      const last = rs[rs.length - 1] as { reactionKey?: string; emoji?: unknown } | undefined;
      const key = last?.reactionKey ?? (typeof last?.emoji === "string" ? last.emoji : "");
      const orig = String((linked as any)?.text || "").replace(/\n/g, " ").trim();
      label = "Reacted" + (key ? ` ${key}` : "") + (orig ? ` to: ${orig.slice(0, 25)}...` : "");
    }
    else if (t) label = "Attachment";
  } catch {}
  mediaTypeCache.set(chat.id, label);
  return label;
}

const avatarCache = new Map<string, string>(); // chatId -> dataURL of composed cell
// chat crawls: only the newest crawl may write state (a poll racing the
// cold-start crawl used to overwrite the full 75 with its partial 25)
let chatCrawlSeq = 0;
// avatar strip pushes: sequential chain + supersede counter (progressive render)
let chatAvatarSeq = 0;
let chatAvatarChain: Promise<void> = Promise.resolve();

// 16px vector messenger glyphs (the 1-bit bitmaps in platformIcons render as
// noise at this size — verified 31.10.). White shapes on the black backing box.
function drawPlatformGlyph(ctx: CanvasRenderingContext2D, plat: string, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 16, s / 16);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.6;
  if (plat === "whatsapp") {
    ctx.beginPath(); ctx.arc(8, 7.5, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(3.5, 12); ctx.lineTo(2, 15.5); ctx.lineTo(6, 13.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.arc(8, 7.5, 4.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(6.6, 5.4, 1.2, 3.4); ctx.fillRect(8.4, 6.2, 1.2, 2.6);
  } else if (plat === "telegram") {
    ctx.beginPath(); ctx.moveTo(1, 7.6); ctx.lineTo(14.6, 1.6); ctx.lineTo(12.4, 13.6); ctx.lineTo(7.6, 10.4); ctx.lineTo(5.2, 13); ctx.lineTo(4.9, 9.4); ctx.closePath(); ctx.fill();
  } else if (plat === "signal") {
    ctx.beginPath(); ctx.arc(8, 7, 5, Math.PI, 0); ctx.lineTo(13, 12); ctx.lineTo(3, 12); ctx.closePath(); ctx.fill();
    ctx.fillRect(2, 12, 12, 1.6); ctx.fillRect(7, 13.6, 2, 1.6);
  } else if (plat === "imessage" || plat === "sms") {
    ctx.beginPath(); ctx.arc(8, 7, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(4, 11.5); ctx.lineTo(3, 15); ctx.lineTo(7, 12.6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#000";
    for (const dx of [5, 8, 11]) ctx.fillRect(dx - 0.7, 6.3, 1.4, 1.4);
  } else if (plat === "messenger") {
    ctx.beginPath(); ctx.arc(8, 8, 6.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.moveTo(9.6, 4.4); ctx.lineTo(6.2, 9); ctx.lineTo(8, 9); ctx.lineTo(6.6, 12.4); ctx.lineTo(10.4, 7.6); ctx.lineTo(8.4, 7.6); ctx.closePath(); ctx.fill();
  } else if (plat === "instagram") {
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.roundRect(2, 2, 12, 12, 4); ctx.stroke();
    ctx.beginPath(); ctx.arc(8, 8, 3.2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillRect(10.8, 4.6, 1.6, 1.6);
  } else if (plat === "discord") {
    ctx.beginPath(); ctx.ellipse(8, 8, 6.6, 5.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.ellipse(5.8, 7.4, 1.5, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(10.2, 7.4, 1.5, 2, 0, 0, Math.PI * 2); ctx.fill();
  } else if (plat === "slack") {
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(5, 2); ctx.lineTo(3.6, 14); ctx.moveTo(12, 2); ctx.lineTo(10.6, 14); ctx.moveTo(1.6, 5.6); ctx.lineTo(14.4, 5.6); ctx.moveTo(1.2, 10.4); ctx.lineTo(14, 10.4); ctx.stroke();
  } else if (plat === "email") {
    ctx.fillRect(1.5, 3.5, 13, 9);
    ctx.fillStyle = "#000"; ctx.beginPath(); ctx.moveTo(1.5, 3.5); ctx.lineTo(8, 9); ctx.lineTo(14.5, 3.5); ctx.closePath(); ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(8, 8, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

async function composeAvatarCell(chat: any, baseUrl: string | undefined): Promise<string> {
  const key = chat.id + "|" + (chat.unreadCount || 0) + "|" + (chat.accountID || "");
  const hit = avatarCache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = AV; cv.height = AV;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, AV, AV);
  // avatar image (best effort)
  let drew = false;
  try {
    // WhatsApp puts the avatar on the participant, not the chat object
    let raw: string | undefined =
      chat.imgURL ||
      (chat.participants?.items || []).find((p: any) => !p.isSelf && p.imgURL)?.imgURL;
    // WhatsApp stores bare Windows paths (C:\...); Beeper's asset route only
    // accepts file:// URLs (or mxc://) — normalize so the serve call works.
    if (raw && /^[a-zA-Z]:[\\/]/.test(raw)) {
      raw = "file:///" + raw.replace(/\\/g, "/");
    }
    if (raw && baseUrl) {
      // Beeper stores avatars as local file paths; its own /v1/assets/serve
      // endpoint (token-authenticated) serves them. The reverse proxy passes
      // that route through, so this works without any dev relay.
      const assetUrl = buildBeeperAssetUrl(normalizeBeeperBaseUrl(baseUrl), raw);
      const token = (await getApiConfig())?.token;
      // two attempts: the gateway answers 503 when >4 requests are in flight,
      // and a truncated body can fail to decode — both are transient
      for (let attempt = 0; attempt < 2 && !drew; attempt++) {
        try {
          const res = await fetch(assetUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
          if (res.ok) {
            const blob = await res.blob();
            if (blob.size > 0) {
              const bmp = await createImageBitmap(blob);
              ctx.save();
              ctx.beginPath(); ctx.arc(AV / 2, AV / 2, AV / 2 - 7, 0, Math.PI * 2); ctx.clip();
              ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 7, 7, AV - 14, AV - 14);
              ctx.restore();
              drew = true;
            }
          }
        } catch (e) {
          console.warn("[avatar] attempt", attempt, String(e).slice(0, 80));
        }
        if (!drew && attempt === 0) await new Promise((r) => setTimeout(r, 350));
      }
    }
  } catch { /* initials fallback below */ }
  if (!drew) {
    // initials fallback
    const name: string = chat.title || "?";
    const ini = name.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
    ctx.fillStyle = "#fff"; ctx.font = "bold 18px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ini || "?", AV / 2, AV / 2);
  }
  // messenger glyph top-right: vector-drawn (the 16px bitmaps in
  // platformIcons render as noise — verified 31.10.), on a black backing box
  try {
    const plat = normalizePlatform(chat.accountID || chat.network || "");
    ctx.fillStyle = "#000"; ctx.fillRect(AV - 16, -1, 17, 17);
    drawPlatformGlyph(ctx, plat, AV - 15.5, 0, 15);
  } catch {}
  // unread badge bottom-right
  const n = chat.unreadCount || 0;
  if (n > 0) {
    const label = String(n);
    const bw = 8 + label.length * 7;
    ctx.fillStyle = "#000"; ctx.fillRect(AV - bw - 1, AV - 15, bw, 14);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(AV - bw - 1, AV - 15, bw, 14);
    ctx.fillStyle = "#fff"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, AV - bw / 2 - 1, AV - 8);
  }
  const url = cv.toDataURL("image/png");
  if (drew) avatarCache.set(key, url); // only cache successes; retry initials next time
  return url;
}

// strip = 5 cells stacked (56x280); returns full grayscale bytes, sliced
// into 3 image containers by the caller (144px per-container height limit).
// Raw grayscale bytes made updateImageRawData return imageException on the
// avatar containers (the spine works and ships PNG) — so emit PNG per slice.
async function renderAvatarStrip(
  chats: any[],
  baseUrl: string | undefined,
): Promise<{ png1: number[]; png2: number[]; png3: number[] }> {
  // parallel but POOLED at 3: sequential cold pages took 8-10s, but full
  // concurrency trips the gateway's 4-in-flight cap (503 → initials)
  const cells: (HTMLImageElement | null)[] = new Array(chats.length).fill(null);
  let nextIdx = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIdx++;
      if (i >= chats.length) return;
      try {
        cells[i] = await loadImage(await composeAvatarCell(chats[i], baseUrl));
      } catch { /* initials fallback stays */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const render = (from: number, to: number): number[] => {
    const h = (to - from) * AVH;
    const cv = document.createElement("canvas");
    cv.width = AV; cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, AV, h);
    for (let i = from; i < to && i < cells.length; i++) {
      const cell = cells[i];
      if (cell) { try { ctx.drawImage(cell, 0, (i - from) * AVH, AV, AVH); } catch {} }
    }
    // Quantize to the display's 16 gray levels: the G2 is 4-bit anyway, and
    // full-color photo PNGs (8-11KB/slice) stalled the BLE transfer until the
    // system killed the page (sendFailed + SYSTEM_EXIT, 30.10. live log).
    const img = ctx.getImageData(0, 0, AV, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = Math.round(((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255) * 15) * 17;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return pngDataUrlToBytes(cv.toDataURL("image/png"));
  };
  return { png1: render(0, 2), png2: render(2, 4), png3: render(4, 5) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

// Even's built-in context menu: chat list filters.
export const MENU_CHATS = 1;
export const MENU_LOW_PRIORITY = 2;
export const MENU_ARCHIVED = 3;
export const MENU_AUDIO = 4;
export const MENU_SPEED = 5;

function filterChats(chats: any[], filter: "normal" | "low" | "archived"): any[] {
  if (filter === "low") return chats.filter((c) => c.isLowPriority && !c.isArchived);
  if (filter === "archived") return chats.filter((c) => c.isArchived);
  return chats.filter((c) => !c.isLowPriority && !c.isArchived);
}

function filterLabel(filter: "normal" | "low" | "archived"): string {
  // center each line inside the 54px column (space ≈ 6px → px/12 = spaces)
  const c = (s: string) => " ".repeat(Math.max(0, Math.round((54 - textPx(s)) / 12))) + s;
  if (filter === "low") return `${c("Low")}\n${c("prio")}`;
  if (filter === "archived") return ` \n${c("Arch.")}`;
  return " ";
}

function clockText(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── message view layout (dynamic containers, max 3 messages/page) ─────────
// Beeper reports reactions natively (message.reactions[].reactionKey).
// The glasses font has no emoji glyphs, so common reactions map to short
// ASCII markers shown after the time. Unknown emoji fall back to "*".
function reactionText(m: BeeperMessage): string {
  const rs = m.reactions;
  if (!Array.isArray(rs) || rs.length === 0) return "";
  // show only ONE reaction (the last = newest Beeper appends); pass the emoji
  // through 1:1 — the firmware renders what it can, skips what it can't.
  const last = rs[rs.length - 1] as { reactionKey?: string; emoji?: unknown };
  const key = last.reactionKey
    ?? (typeof last.emoji === "string" ? last.emoji : "");
  return key ? " " + key : "";
}
const MSG_TIME_W = 124;
// bubble width shared by wrap calc and layout (full width minus time column)
const MSG_BUB_W = 574 - MSG_TIME_W - 4;
function msgGeom(_isMine: boolean) {
  return { bubbleW: MSG_BUB_W };
}

function wrapToPx(text: string, maxPx: number): string[] {
  const out: string[] = [];
  // hard-break a token that alone exceeds the width (long URLs without spaces)
  const breakWord = (w: string): string[] => {
    if (textPx(w) <= maxPx) return [w];
    const parts: string[] = [];
    let cur = "";
    for (const ch of w) {
      if (textPx(cur + ch) > maxPx) { parts.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  };
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      for (const piece of breakWord(word)) {
        const test = cur ? cur + " " + piece : piece;
        if (textPx(test) <= maxPx) cur = test;
        else { if (cur) out.push(cur); cur = piece; }
      }
    }
    out.push(cur || "");
  }
  return out.length ? out : [""];
}

// set by the renderer/scroll handler: group chats prefix foreign messages
// with the sender name so you know who wrote what
let msgIsGroup = false;
function msgBubbleText(msg: BeeperMessage, all: BeeperMessage[]): string {
  let t = stripUnsupportedChars(formatMessageText(msg)).replace(/\r/g, "").trim();
  const ty0 = (msg.type || "").toUpperCase();
  if (ty0 === "VOICE") {
    // voice notes render as a one-line transport bar (video design); the
    // position/duration come from the voice engine when THIS message is the
    // loaded one, else a static 0:00 bar
    const active = voiceMsgId() === msg.id;
    t = videoTransportLine(active ? voicePos() : 0, active ? voiceDur() : 0, active && voicePlaying());
  } else if (!t || t === "[media]") {
    const fname = (msg.attachments as any[])?.[0]?.filename || (msg.attachments as any[])?.[0]?.fileName;
    t = ty0 === "IMAGE" ? "[Photo]" : ty0 === "VIDEO" ? "[Video]" : ty0 === "AUDIO" ? "[Audio]" : ty0 === "VOICE" ? "[Voice]" : ty0 === "FILE" ? (fname ? `[File: ${fname}]` : "[File]") : "[media]";
  }
  if (msg.linkedMessageID) {
    const linked = all.find((m) => m.id === msg.linkedMessageID);
    if (linked) {
      const lt = stripUnsupportedChars(formatMessageText(linked)).replace(/\n/g, " ").trim();
      if (lt) t = "Answer to: " + truncatePx(lt, 300) + "\n" + t;
    }
  }
  // group chats: "Name wrote:" on its own line above foreign messages
  if (msgIsGroup && !msg.isSender) {
    const who = (msg.senderName || "").trim();
    if (who) t = truncatePx(who, 300) + " wrote:\n" + t;
  }
  return t;
}

interface MsgItem { msg: BeeperMessage; lines: string[]; block: number; blocks: number }
const MSG_LINE_H = 30;
const MSG_RESERVE = 8;
const MSG_GAP = 6;
const MSG_AREA_Y = 44;
const MSG_AREA_H = 200; // y 44..244 (input bar below)
const MSG_MAX_LINES = Math.floor((MSG_AREA_H - MSG_RESERVE) / MSG_LINE_H); // 7
function attachmentAspect(m: BeeperMessage): number {
  const sz = (m.attachments as any[])?.[0]?.size;
  const w = Number(sz?.width) || 0, h = Number(sz?.height) || 0;
  return w > 0 && h > 0 ? w / h : 1;
}
function imageAssetUrl(m: BeeperMessage, baseUrl: string | undefined): string | null {
  const att = (m.attachments as any[])?.[0];
  const raw: string | undefined = att?.srcURL || att?.url;
  if (!raw || !baseUrl) return null;
  try { return buildBeeperAssetUrl(normalizeBeeperBaseUrl(baseUrl), raw); } catch { return null; }
}
function voiceAssetUrl(m: BeeperMessage, baseUrl: string | undefined): string | null {
  const att = (m.attachments || []).find((a: any) =>
    (a.type || "").toLowerCase() === "audio" || (a.mimeType || "").startsWith("audio"));
  const raw: string | undefined = att?.srcURL || att?.url;
  if (!raw || !baseUrl) return null;
  try { return buildBeeperAssetUrl(normalizeBeeperBaseUrl(baseUrl), raw); } catch { return null; }
}
function videoAssetUrl(m: BeeperMessage, baseUrl: string | undefined): string | null {
  const att = (m.attachments || []).find((a: any) => (a.type || "").toLowerCase() === "video" || (a.mimeType || "").startsWith("video"));
  const raw: string | undefined = att?.srcURL || att?.url;
  if (!raw || !baseUrl) return null;
  try {
    return buildBeeperAssetUrl(normalizeBeeperBaseUrl(baseUrl), raw);
  } catch { return null; }
}
// one-line transport inside the video bubble, bottom row:
//   "▷ 00:00  ▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏  01:23"
// 10 slots = 10% steps; played slots become ▒ (U+2592 medium shade), empty
// slots are ▁ (U+2581 bottom hairline). Both share the ~20px device advance
// (space would be 6px → drifting line), so the width stays constant.
// fullwidth digits (U+FF10–FF19) are equal-width by Unicode design — IF the
// firmware font contains them (U+3000 was missing on device, so this is a
// live test; VID_FW_DIGITS=false reverts to the proportional ASCII digits)
const VID_FW_DIGITS = true;
const fwDigits = (t: string) =>
  VID_FW_DIGITS ? t.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))) : t;
function videoTransportLine(pos: number, dur: number, playing: boolean): string {
  const slots = 10;
  const n = dur > 0 ? Math.max(0, Math.min(slots, Math.round((pos / dur) * slots))) : 0;
  const bar = "\u2592".repeat(n) + "\u2581".repeat(slots - n);
  const icon = playing ? "||" : "\u25B7";
  return `${icon} ${fwDigits(fmtDur(pos))}  ${bar}  ${fwDigits(fmtDur(dur))}`;
}
function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), r = Math.floor(sec % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
function isMediaMsg(m: BeeperMessage): boolean {
  const t = (m.type || "").toUpperCase();
  return t === "IMAGE" || t === "VIDEO";
}
function msgLineCount(m: BeeperMessage, all: BeeperMessage[]): number {
  return wrapToPx(msgBubbleText(m, all), msgGeom(m.isSender).bubbleW - 14).length;
}
// a message owns a block-paginated page when it's media or taller than the area
function isVoiceMsg(m: BeeperMessage): boolean {
  return (m.type || "").toUpperCase() === "VOICE";
}
function ownsPage(m: BeeperMessage, all: BeeperMessage[]): boolean {
  return isMediaMsg(m) || msgNatH(m, all) > MSG_AREA_H;
}
// pages pack by NATURAL HEIGHT (real data: >2-line messages are common, so
// count-based grouping pushed nearly everything into its own full page).
// A message that alone exceeds the area gets its own block-paginated page.
interface MsgPage { start: number; end: number }
const msgNatH = (m: BeeperMessage, all: BeeperMessage[]) =>
  msgLineCount(m, all) * MSG_LINE_H + MSG_RESERVE;
function buildMsgPages(messages: BeeperMessage[]): MsgPage[] {
  const pages: MsgPage[] = [];
  let i = messages.length - 1;
  while (i >= 0) {
    if (ownsPage(messages[i], messages)) { pages.push({ start: i, end: i }); i--; continue; }
    let s = i, total = msgNatH(messages[i], messages), count = 1;
    while (s > 0 && count < 3) {
      // media owns its page — packing it with neighbours (its "[Video]" text
      // is 1 line tall) delayed the preview until the focus passed through
      if (ownsPage(messages[s - 1], messages)) break;
      const ph = msgNatH(messages[s - 1], messages);
      if (ph > MSG_AREA_H || total + ph + MSG_GAP > MSG_AREA_H) break;
      s--; count++; total += ph + MSG_GAP;
    }
    pages.push({ start: s, end: i });
    i = s - 1;
  }
  return pages;
}
function msgPageFor(pages: MsgPage[], f: number): MsgPage {
  return pages.find((p) => f >= p.start && f <= p.end) || pages[0];
}
function computeMsgLayout(
  messages: BeeperMessage[],
  block: number,
  loading = false,
  focusIdx = -1,
): { focus: boolean; items: MsgItem[] } {
  if (messages.length === 0) {
    return { focus: false, items: [{ msg: {} as BeeperMessage, lines: [loading ? "Loading messages..." : "No messages yet - send one!"], block: 0, blocks: 1 }] };
  }
  let fi = focusIdx >= 0 ? Math.min(focusIdx, messages.length - 1) : -1;
  // mic focus on a chat whose NEWEST message is oversized → show that message
  // block-paginated (block 0) instead of one bubble that bleeds into the input
  if (fi < 0 && messages.length && ownsPage(messages[messages.length - 1], messages)) {
    fi = messages.length - 1;
  }
  if (fi >= 0 && ownsPage(messages[fi], messages)) {
    const isImg = (messages[fi].type || "").toUpperCase() === "IMAGE";
    const selLines = wrapToPx(msgBubbleText(messages[fi], messages), msgGeom(messages[fi].isSender).bubbleW - 14);
    // images own their page but NEVER block-paginate: a long caption used to
    // flip them into multi-block text mode and break the photo render
    const blocks = isImg ? 1 : Math.max(1, Math.ceil(selLines.length / MSG_MAX_LINES));
    const b = Math.max(0, Math.min(block, blocks - 1));
    return { focus: true, items: [{ msg: messages[fi], lines: isImg ? [] : selLines.slice(b * MSG_MAX_LINES, (b + 1) * MSG_MAX_LINES), block: b, blocks }] };
  }
  // the page containing the focus (mic focus → newest page)
  const pages = buildMsgPages(messages);
  const p = fi < 0 ? pages[0] : msgPageFor(pages, fi);
  const items: MsgItem[] = messages.slice(p.start, p.end + 1).map((m) => ({
    msg: m,
    lines: wrapToPx(msgBubbleText(m, messages), msgGeom(m.isSender).bubbleW - 14),
    block: 0,
    blocks: 1,
  }));
  return { focus: false, items };
}

// mic glyph for the input bar: 34x34 grayscale PNG, drawn once
let micIconBytes: number[] | null = null;
let micIconBytesDim: number[] | null = null;
function getMicIcon(dim = false): number[] {
  if (dim) {
    if (micIconBytesDim) return micIconBytesDim;
  } else if (micIconBytes) return micIconBytes;
  const S = 34;
  const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
  // capsule
  ctx.beginPath(); ctx.roundRect(13, 5, 8, 14, 4); ctx.fill();
  // arc
  ctx.beginPath(); ctx.arc(17, 16, 8, 0, Math.PI); ctx.stroke();
  // stem + base
  ctx.fillRect(16, 24, 2, 5); ctx.fillRect(11, 29, 12, 2);
  const img = ctx.getImageData(0, 0, S, S); const d = img.data;
  // scale luminance by lvl/15 — the old quantization formula mapped FULL
  // WHITE to 255 in both variants, so the "dim" mic looked identical
  const lvl = dim ? 5 : 15;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * lvl) / 15);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  const bytes = pngDataUrlToBytes(cv.toDataURL("image/png"));
  if (dim) micIconBytesDim = bytes; else micIconBytes = bytes;
  return bytes;
}

// ── compose editor: private typing on the glasses via a hidden phone input ──
// Same proven engine as the Edit-Mode test: an invisible <input> receives the
// hardware/software keyboard (nothing shows on the phone = privacy); only a
// pixel-windowed slice around the caret is mirrored to the glasses input
// container. Ctrl/Alt+arrows move the caret, Ctrl+Backspace/Delete delete
// words, Enter sends, Escape clears.
let composeText = "";
// the input container is the scroll catcher; its placeholder would visibly
// rubber-band on gestures → dropped after the first scroll (Joel 02.11.)
let inputHintGone = false;
const INPUT_HINT = "Type on your phone or tap to record or transcribe";
const inputHint = () => (inputHintGone ? " " : INPUT_HINT);
let composeCaret = 0;
let composeArmed = false;
let composeWantFocus = false;
let composeMirror: (() => void) | null = null;
let composeSend: ((t: string) => Promise<boolean>) | null = null;
let composeInput: HTMLInputElement | null = null;
// draft sync (Joel 02.11.): prefill the compose box from Beeper's draft when a
// chat opens; write it back when the chat view is left. dirty-tracked so a
// mere peek into a chat never rewrites the draft.
let draftChatId: string | null = null;
let draftSaved = "";
function draftToText(html?: string | null): string {
  if (!html) return "";
  return sanitizeHtmlAndEntities(html).replace(/\r/g, "").replace(/\n+/g, " ").trim();
}
/** Prefill compose from a chat's draft (called on chat open). */
function gcSeedDraft(chatId: string, draftHtml?: string | null) {
  const text = draftToText(draftHtml);
  draftChatId = chatId;
  draftSaved = text;
  composeText = text;
  composeCaret = text.length;
  const el = ensureComposeInput();
  el.value = text;
  try { el.setSelectionRange(text.length, text.length); } catch { /* ignore */ }
}
/** Persist the current compose text as the chat draft (debounced). */
function gcSaveDraftNow() {
  const chatId = draftChatId;
  if (!chatId) return;
  const text = composeText;
  if (text === draftSaved) return; // unchanged — never rewrite
  draftSaved = text;
  const client = beeperRefForDraft();
  if (!client) return;
  void client.updateDraft(chatId, text).catch((e) => console.warn("[draft] save failed:", String(e).slice(0, 80)));
}
// set once the beeper client is available (assigned in the component body)
let _beeperForDraft: { updateDraft: (id: string, t: string | null) => Promise<void> } | null = null;
function beeperRefForDraft() { return _beeperForDraft; }
let composePoll: ReturnType<typeof setInterval> | null = null;
const COMPOSE_PX = 520; // usable width of the glasses input container

function composeWindow(): string {
  const text = composeText;
  const caret = Math.max(0, Math.min(composeCaret, text.length));
  let start = caret, end = caret, w = glyphW("|"), grow = true;
  while (true) {
    const room = COMPOSE_PX - w;
    if (room <= 0) break;
    if (grow && end < text.length) {
      const cw = glyphW(text[end]);
      if (cw > room) { if (start === 0) break; } else { w += cw; end++; }
    } else if (start > 0) {
      const cw = glyphW(text[start - 1]);
      if (cw > room && end === text.length) break;
      w += cw; start--;
    } else if (end === text.length) break;
    grow = !grow;
    if (start === 0 && end === text.length) break;
  }
  return (start > 0 ? "\u2039" : "") + text.slice(start, caret) + "|" + text.slice(caret, end) + (end < text.length ? "\u203a" : "");
}
let lastMirrorTxt: string | null = null;
function mirrorCompose() { composeMirror?.(); }
function syncFromInput(el: HTMLInputElement) {
  composeText = el.value;
  composeCaret = el.selectionStart ?? el.value.length;
  mirrorCompose();
}
function ensureComposeInput() {
  if (composeInput) return composeInput;
  const el = document.createElement("input");
  el.type = "text";
  el.autocapitalize = "off"; el.autocomplete = "off"; el.spellcheck = false;
  Object.assign(el.style, {
    position: "fixed", left: "0", top: "0", width: "1px", height: "1px",
    opacity: "0", border: "0", padding: "0", background: "transparent", color: "transparent",
  } as CSSStyleDeclaration);
  document.body.appendChild(el);
  const word = (fwd: boolean) => {
    const s = el.value; let pos = el.selectionStart ?? s.length; const end = el.selectionEnd ?? pos;
    if (fwd) { const from = Math.max(pos, end); const m = s.slice(from).match(/[\w\u00C0-\u024F][^\s]*/); return m ? from + (m.index ?? 0) + m[0].length : s.length; }
    let i = Math.min(pos, end) - 1;
    while (i > 0 && /\s/.test(s[i])) i--;
    while (i > 0 && !/\s/.test(s[i - 1])) i--;
    return Math.max(0, i);
  };
  el.addEventListener("input", () => syncFromInput(el));
  el.addEventListener("keyup", () => syncFromInput(el));
  el.addEventListener("click", () => syncFromInput(el));
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    const s = el.value; let pos = el.selectionStart ?? s.length; const end = el.selectionEnd ?? pos;
    const jump = e.ctrlKey || e.metaKey;
    let handled = true;
    if (e.key === "ArrowLeft") pos = jump ? word(false) : Math.max(0, Math.min(pos, end) - 1);
    else if (e.key === "ArrowRight") pos = jump ? word(true) : Math.min(s.length, Math.max(pos, end) + 1);
    else if (e.key === "Home") pos = 0;
    else if (e.key === "End") pos = s.length;
    else if (e.key === "Delete" && jump) { const to = pos === end ? word(true) : Math.max(pos, end); el.setRangeText("", Math.min(pos, end), to, "end"); pos = Math.min(pos, end); el.dispatchEvent(new Event("input")); }
    else if (e.key === "Backspace" && jump) { const from = pos === end ? word(false) : Math.min(pos, end); el.setRangeText("", from, Math.max(pos, end), "end"); pos = from; el.dispatchEvent(new Event("input")); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const t = el.value.trim();
      if (t && composeSend) { el.value = ""; composeText = ""; composeCaret = 0; mirrorCompose(); void composeSend(t); }
      return;
    } else if (e.key === "Escape") { el.value = ""; composeText = ""; composeCaret = 0; mirrorCompose(); return; }
    else handled = false;
    if (handled) { e.preventDefault(); el.setSelectionRange(pos, pos); syncFromInput(el); }
  });
  el.addEventListener("blur", () => { if (composeArmed && composeWantFocus) setTimeout(() => el.focus(), 50); });
  // any other field taking focus (settings inputs) releases the glasses grab
  document.addEventListener("focusin", (ev) => {
    if (ev.target !== el) composeWantFocus = false;
  });
  composeInput = el;
  return el;
}
export function gcArmCompose(on: boolean) {
  composeArmed = on;
  const el = ensureComposeInput();
  if (on) {
    composeWantFocus = true;
    el.focus({ preventScroll: true });
    if (!composePoll) composePoll = setInterval(() => {
      if (!composeArmed) return;
      // only mirror on REAL changes — an identical-content upgrade still makes
      // the firmware redraw the container (visible flicker while idle-typing)
      const v = el.value;
      const c = el.selectionStart ?? v.length;
      if (v !== composeText || c !== composeCaret) syncFromInput(el);
    }, 80);
  } else {
    composeWantFocus = false;
    try { el.blur(); } catch {}
    if (composePoll) { clearInterval(composePoll); composePoll = null; }
  }
}
// Explicit user gesture (banner tap) reclaims keyboard focus for the glasses.
export function gcFocusCompose() {
  composeWantFocus = true;
  ensureComposeInput().focus({ preventScroll: true });
}
export function gcRegisterSend(fn: (t: string) => Promise<boolean>) { composeSend = fn; }
// rebind helper: call on every render so composeSend never holds a stale
// closure (beeper/config arrive asynchronously after the first render)
let composeSendRef: (() => (t: string) => Promise<boolean>) | null = null;
export function gcBindSend(make: () => (t: string) => Promise<boolean>) {
  composeSendRef = make;
  composeSend = (t) => {
    const fn = composeSendRef ? composeSendRef() : null;
    return fn ? fn(t) : Promise.resolve(false);
  };
}



// top-bar chat avatar: 36x36 rounded grayscale PNG (cached per chat)
const topAvatarCache = new Map<string, number[]>();
async function renderTopAvatar(chat: any, baseUrl: string | undefined): Promise<number[]> {
  const key = chat?.id || "none";
  const hit = topAvatarCache.get(key);
  if (hit) return hit;
  const S = 36;
  const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, S, S);
  let drew = false;
  try {
    let raw: string | undefined = chat?.imgURL ||
      (chat?.participants?.items || []).find((x: any) => !x.isSelf && x.imgURL)?.imgURL;
    if (raw && /^[a-zA-Z]:[\\/]/.test(raw)) raw = "file:///" + raw.replace(/\\/g, "/");
    if (raw && baseUrl) {
      const assetUrl = buildBeeperAssetUrl(normalizeBeeperBaseUrl(baseUrl), raw);
      const token = (await getApiConfig())?.token;
      const res = await fetch(assetUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 0) {
          const bmp = await createImageBitmap(blob);
          ctx.save(); ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2); ctx.clip();
          ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 1, 1, S - 2, S - 2); ctx.restore();
          drew = true;
        }
      }
    }
  } catch {}
  if (!drew) {
    const ini = (chat?.title || "?").split(/\s+/).slice(0, 2).map((w: string) => w[0] || "").join("").toUpperCase();
    ctx.fillStyle = "#fff"; ctx.font = "bold 14px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ini || "?", S / 2, S / 2);
  }
  // messenger glyph baked top-right (like the chat-list avatars) — one image,
  // no separate icon container to redraw
  try {
    const plat = normalizePlatform(chat?.accountID || chat?.network || "");
    ctx.fillStyle = "#000"; ctx.fillRect(S - 15, -1, 16, 16);
    drawPlatformGlyph(ctx, plat, S - 14, 0, 14);
  } catch {}
  const img = ctx.getImageData(0, 0, S, S); const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255) * 15) * 17;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  const bytes = pngDataUrlToBytes(cv.toDataURL("image/png"));
  topAvatarCache.set(key, bytes);
  return bytes;
}

function getMaxIndex(state: AppState, chatFilter: "normal" | "low" | "archived" = "normal"): number {
  switch (state.currentScreen) {
    case "startup":
      return 0;
    case "accounts": {
      const uniqueAccounts = new Set(state.accounts.map((a) => a.accountID));
      return Math.max(0, uniqueAccounts.size); // +1 for "All Chats" at index 0
    }
    case "chats":
      // NOTE: no +1 anymore — the old "All Platforms" row at index 0 is gone;
      // returning length here let the cursor run onto a phantom row (02.11.)
      return Math.max(0, filterChats(state.chats, chatFilter).length - 1);
        case "messages":
          return Math.max(0, state.messages.length - 1);
        case "quickReply":
          return Math.max(0, QUICK_REPLIES.length - 1);
        case "voiceReply":
        case "messageDetail":
          return 0;
  }
}

function normalizeSpeechBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function mergeAudioChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function pcmToWavBlob(pcm: Uint8Array): Blob {
  const headerLength = 44;
  const wavBuffer = new ArrayBuffer(headerLength + pcm.length);
  const view = new DataView(wavBuffer);
  const byteRate = PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8);
  const blockAlign = PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, PCM_CHANNELS, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM_BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.length, true);
  new Uint8Array(wavBuffer, headerLength).set(pcm);

  return new Blob([wavBuffer], { type: "audio/wav" });
}

async function transcribePcmAudio(
  speechConfig: SpeechApiConfig,
  pcm: Uint8Array,
): Promise<string> {
  const formData = new FormData();
  formData.append("model", speechConfig.model);
  formData.append("file", pcmToWavBlob(pcm), "voice-reply.wav");

  const response = await fetch(
    `${normalizeSpeechBaseUrl(speechConfig.baseUrl)}/audio/transcriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${speechConfig.token}`,
      },
      body: formData,
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Transcription request failed (${response.status})`);
  }

  const json = (await response.json()) as TranscriptionResponse;
  return (json.text || "").trim();
}

// ═══════════════════════════════════════════════════════════════
// DISPLAY BUILDERS
// ═══════════════════════════════════════════════════════════════

function buildAccountsDisplay(
  state: AppState,
  highlightedIdx: number,
): DisplayLine[] {
  const lines: DisplayLine[] = [];

  // Header: "GazeChat" + time (+ DEMO indicator if active)
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const title = state.demoMode ? "GazeChat [DEMO]" : "GazeChat";
  lines.push(line(buildHeaderLine(title, time), "inverted"));

  // "All Chats" option
  const allSelected = highlightedIdx === 0;
  lines.push(
    line(
      `${allSelected ? ICONS.SELECTED : " "} * All Chats`,
      allSelected ? "inverted" : "normal",
    ),
  );

  // Unique accounts
  const seen = new Set<string>();
  let itemIdx = 1; // Start at 1 since 0 is "All Chats"

  state.accounts.forEach((a) => {
    if (!seen.has(a.accountID)) {
      seen.add(a.accountID);
      const isSelected = highlightedIdx === itemIdx;
      const icon = getServiceIcon(a.accountID);
      const name = a.user.fullName || a.user.username || "Unknown";

      // Full width line
      const lineText = `${isSelected ? ICONS.SELECTED : " "} ${icon} ${padRight(truncateName(name, 28), 28)}`;
      lines.push(line(lineText, isSelected ? "inverted" : "normal"));
      itemIdx++;
    }
  });

  lines.push(sep());
  lines.push(line(buildStaticActionBar(["Select"], -1), "meta"));

  return lines;
}

function buildChatsDisplay(
  state: AppState,
  highlightedIdx: number,
): DisplayLine[] {
  const lines: DisplayLine[] = [];

  if (state.isLoading) {
    // Show loading indicator
    lines.push(line("Loading...", "normal"));
    lines.push(line("", "normal"));
    lines.push(line("", "normal"));
    lines.push(line("", "normal"));
  } else if (state.setupRequired) {
    lines.push(line("Open the app on", "normal"));
    lines.push(line("your phone to", "normal"));
    lines.push(line("configure it.", "normal"));
  } else if (state.chats.length === 0) {
    lines.push(line("No chats found", "normal"));
  } else {
    const { start, visible } = getVisibleChatWindow(
      state.chats,
      highlightedIdx,
    );

    visible.forEach((chat, idx) => {
      const globalIdx = start + idx;
      const isSelected = globalIdx === highlightedIdx;

      // Format: > [12]  Contact name…   (unread badge FIRST, pixel-aligned)
      const marker = `${isSelected ? ICONS.SELECTED : " "} `;
      const badge =
        chat.unreadCount > 0 ? `[${chat.unreadCount}]` : "";
      // badge column: fixed pixel width so names always start at the same x
      const BADGE_PX = 52; // fits [999] + gap; single digits get the 2-space gap via padding
      const badgeCol = padPx(badge ? badge + " " : "", BADGE_PX);
      // name gets the rest of the list container width (~500px usable)
      const namePx = 500 - textPx(marker) - textPx(badgeCol);
      const name = truncatePx(chat.title, namePx);
      const lineText = `${marker}${badgeCol}${name}`;
      lines.push(line(lineText, isSelected ? "inverted" : "normal"));
    });
  }

  return lines;
}

function buildMessagesDisplay(
  state: AppState,
  _highlightedIdx: number,
): DisplayLine[] {
  const lines: DisplayLine[] = [];

  // Header with back + chat name
  const chat = state.chats.find((c) => c.id === state.selectedChat);
  const chatName = chat ? truncateName(chat.title, 20) : "Messages";
  lines.push(
    line(buildHeaderLine(`${ICONS.BACK} ${chatName}`, ""), "inverted"),
  );

  // Show loading indicator if loading
  if (state.isLoading) {
    lines.push(line("Loading messages...", "normal"));
    if (state.messageLoadingTimedOut) {
      lines.push(line("", "normal"));
      lines.push(line("Open the app on", "normal"));
      lines.push(line("your phone to", "normal"));
      lines.push(line("configure it.", "normal"));
    } else {
      lines.push(line("", "normal"));
      lines.push(line("", "normal"));
      lines.push(line("", "normal"));
      lines.push(line("", "normal"));
    }
    lines.push(sep());
    lines.push(line(buildStaticActionBar(["Back"], 0), "meta"));
    return lines;
  }

  if (state.messageLoadFailed || state.setupRequired) {
    lines.push(line("", "normal"));
    lines.push(line("Open the app on", "normal"));
    lines.push(line("your phone to", "normal"));
    lines.push(line("configure it.", "normal"));
    lines.push(sep());
    lines.push(line(buildStaticActionBar(["Back"], 0), "meta"));
    return lines;
  }

  // Calculate scroll window
  const totalMessages = state.messages.length;
  const maxScroll = Math.max(0, totalMessages - 1);
  const selectedIdx = Math.min(state.messageScrollOffset, maxScroll);

  // Visible window: keep selected message in view
  const maxItems = DISPLAY_LINES - 3; // header, separator, action bar
  const maxStart = Math.max(0, totalMessages - maxItems);
  const start = Math.max(0, Math.min(maxStart, selectedIdx - 1));
  const visibleMessages = state.messages.slice(start, start + maxItems);
  const end = start + visibleMessages.length;

  // Indicator if more messages above
  if (start > 0) {
    lines.push(line("          ▲", "meta"));
  }

  // Render message list with cursor on selected message
  if (totalMessages === 0) {
    lines.push(line("No messages yet - send one!", "normal"));
  } else {
    visibleMessages.forEach((msg, idx) => {
      const globalIdx = start + idx;
      const isSelected = globalIdx === selectedIdx;
      const time = formatTime(msg.timestamp);
      const sender = truncateName(senderLabel(msg) || "?", 8);
      const prefix = `[${time}] ${sender}: `;
      const preview = truncate(
        getMessagePreview(msg),
        DISPLAY_WIDTH - prefix.length - 2,
      ); // -2 for cursor + space
      const lineText = `${isSelected ? ICONS.SELECTED : " "} ${prefix}${preview}`;
      lines.push(line(lineText, isSelected ? "inverted" : "normal"));
    });
  }

  // Indicator if more messages below
  if (end < totalMessages) {
    lines.push(line("          ▼", "meta"));
  }

  lines.push(sep());

  // Action bar with position info
  const posText = totalMessages > 0 ? `${selectedIdx + 1}/${totalMessages}` : "";
  lines.push(
    line(
      buildStaticActionBar(["Back"], -1) + (posText ? "  " + posText : ""),
      "meta",
    ),
  );

  return lines;
}

function buildMessageDetailDisplay(
  state: AppState,
  imageStatus: MessageDetailImageStatus,
): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const msg = state.messages[state.selectedMessageIndex];

  if (!msg) {
    lines.push(line(buildHeaderLine("Message", ""), "inverted"));
    lines.push(line("Message unavailable", "normal"));
    lines.push(line("", "normal"));
    lines.push(line("", "normal"));
    lines.push(line("", "normal"));
    lines.push(line("", "normal"));
    lines.push(sep());
    lines.push(line("Click: Reply  Double: Back", "meta"));
    return lines;
  }

  const sender = truncateName(senderLabel(msg) || msg.senderID || "Unknown", 20);
  const time = formatTime(msg.timestamp);
  const wrappedBody = getMessageDetailWrappedBody(msg);
  const hasLoadedImage = imageStatus === "loaded";
  const availableBodyLines = hasLoadedImage
    ? 2
    : Math.max(0, DISPLAY_LINES - 4);
  const maxScroll = Math.max(0, wrappedBody.length - availableBodyLines);
  const scrollOffset = Math.min(state.messageDetailScrollOffset, maxScroll);
  const visibleBody = wrappedBody.slice(
    scrollOffset,
    scrollOffset + availableBodyLines,
  );

  lines.push(line(buildHeaderLine(sender, time), "inverted"));
  if (imageStatus === "loading") {
    lines.push(line("Loading image...", "meta"));
  } else if (imageStatus === "failed") {
    lines.push(line("Image unavailable", "meta"));
  }
  lines.push(...visibleBody.map((entry) => line(entry, "normal")));
  while (lines.length < DISPLAY_LINES - 3) {
    lines.push(line("", "normal"));
  }
  const indicator =
    maxScroll > 0
      ? `${scrollOffset > 0 ? "▲ " : ""}${maxScroll > scrollOffset ? "▼ " : ""}${Math.min(scrollOffset + availableBodyLines, wrappedBody.length)}/${wrappedBody.length}`
      : `${wrappedBody.length}/${wrappedBody.length}`;
  lines.push(line(indicator, "meta"));

  lines.push(sep());
  lines.push(line("Click: Reply  Double: Back", "meta"));

  return lines;
}

function buildQuickReplyDisplay(
  state: AppState,
  highlightedIdx: number,
): DisplayLine[] {
  const lines: DisplayLine[] = [];

  const msg = state.messages[state.selectedMessageIndex];
  const sender = msg
    ? truncateName(senderLabel(msg) || "Unknown", 16)
    : "Unknown";
  lines.push(line(buildHeaderLine(`Reply: ${sender}`, ""), "inverted"));

  const selectedReply =
    QUICK_REPLIES[Math.min(highlightedIdx, QUICK_REPLIES.length - 1)] || "";
  const availableReplyRows = Math.max(
    0,
    DISPLAY_LINES - 1 - STICKY_FOOTER_LINES,
  );
  const optionLines: DisplayLine[] = QUICK_REPLIES.map((reply, idx) => {
    const isSelected = idx === highlightedIdx;
    const prefix = isSelected ? ICONS.SELECTED : " ";
    return line(
      `${prefix} ${truncate(reply, 34)}`,
      isSelected ? "inverted" : "normal",
    );
  });

  const visibleCount = Math.min(optionLines.length, availableReplyRows);
  const windowStart = Math.max(
    0,
    Math.min(
      highlightedIdx - Math.floor(visibleCount / 2),
      Math.max(0, optionLines.length - visibleCount),
    ),
  );

  lines.push(...optionLines.slice(windowStart, windowStart + visibleCount));
  lines.push(sep());
  const footerLabel =
    selectedReply === "Voice"
      ? "Click to speak"
      : `Send : ${truncate(selectedReply, 34)}`;
  lines.push(line(footerLabel, "meta"));

  return lines;
}

function buildVoiceReplyDisplay(state: AppState): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const msg = state.messages[state.selectedMessageIndex];
  const sender = msg
    ? truncateName(senderLabel(msg) || "Unknown", 16)
    : "Unknown";
  const status = state.voiceStatus || "Speak now";
  const isVoiceReady = state.voiceTranscript.trim().length > 0;
  const isSpeechUnavailable =
    status === VOICE_NOT_CONFIGURED_STATUS ||
    status === VOICE_MIC_UNAVAILABLE_STATUS ||
    status === VOICE_TRANSCRIPTION_FAILED_STATUS;
  const isTranscribing = status === "Transcribing...";
  const isSending = status === VOICE_SENDING_STATUS;
  const sendFailed = status === VOICE_SEND_FAILED_STATUS;
  const isRecording = status === "Listening..." && state.voiceAudioBytes > 0;

  lines.push(line(buildHeaderLine(`Voice: ${sender}`, ""), "inverted"));

  const voiceBody =
    isSending || sendFailed ? status : state.voiceTranscript || status;
  const bodyLines = [
    line(
      isSending
        ? "Sending reply"
        : sendFailed
          ? "Reply not sent"
          : isVoiceReady
            ? "Review reply"
        : isSpeechUnavailable
          ? "Voice unavailable"
          : isTranscribing
            ? "Processing audio"
            : "Listening...",
      "normal",
    ),
    line(truncate(voiceBody, 38), "normal"),
  ];
  const availableBodyLines = Math.max(
    0,
    DISPLAY_LINES - 1 - STICKY_FOOTER_LINES,
  );

  lines.push(...bodyLines.slice(0, availableBodyLines));
  lines.push(sep());
  lines.push(
    line(
      isSending
        ? "Please wait"
        : sendFailed
          ? "Click to retry"
          : isVoiceReady
            ? "Click to send"
        : isSpeechUnavailable
          ? status === VOICE_NOT_CONFIGURED_STATUS
            ? "Configure Speech in Settings"
            : "Click to retry"
          : isTranscribing
            ? "Please wait"
            : isRecording
              ? "Click when done"
              : "Speak now",
      "meta",
    ),
  );

  return lines;
}

function buildStartupDisplay(tick: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  lines.push(line(buildHeaderLine("GazeChat", time), "inverted"));
  lines.push(sep());

  // Centered framed loading box with animated dots (fixed width, no jitter)
  const dots = ".".repeat(tick % 4);
  const text = "Loading messages";
  const inner = text.length + 6; // room for "  " + up to 3 dots
  const left = Math.max(0, Math.floor((DISPLAY_WIDTH - (inner + 2)) / 2));
  const pad = " ".repeat(left);
  lines.push(line("", "normal"));
  lines.push(line(`${pad}┌${"─".repeat(inner)}┐`, "normal"));
  lines.push(line(`${pad}│  ${padRight(text + dots, inner - 2)}│`, "normal"));
  lines.push(line(`${pad}└${"─".repeat(inner)}┘`, "normal"));
  lines.push(sep());
  lines.push(line("", "meta"));
  return lines;
}

function getSelectedSender(state: AppState): string {
  const msg = state.messages[state.selectedMessageIndex];
  return truncateName(senderLabel(msg ?? {}) || "Unknown", 20);
}

function buildQuickReplyItems(): string[] {
  return [...QUICK_REPLIES, QUICK_REPLY_CANCEL].map((item) =>
    truncate(stripUnsupportedChars(item), 64),
  );
}

function buildVoiceCardContent(state: AppState): string {
  const sender = getSelectedSender(state);
  const transcript = stripUnsupportedChars(state.voiceTranscript.trim());
  const status = stripUnsupportedChars(state.voiceStatus || "Speak now");
  const body = transcript || status;

  return truncate(`Voice reply\n${sender}\n\n${body}`, 950);
}

function buildMessageDetailContent(msg: BeeperMessage): string {
  const sender = stripUnsupportedChars(senderLabel(msg) || msg.senderID || "Unknown");
  const time = stripUnsupportedChars(formatTime(msg.timestamp));
  const fullText = stripUnsupportedChars(formatMessageText(msg));

  return `${sender}  ${time}\n\n${fullText}\n\nClick: Reply\nDouble click: Back`;
}

function areMessagesEqual(a: BeeperMessage[], b: BeeperMessage[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.sortKey !== right.sortKey ||
      left.timestamp !== right.timestamp ||
      left.text !== right.text ||
      left.senderName !== right.senderName ||
      left.isSender !== right.isSender ||
      left.type !== right.type
    ) {
      return false;
    }
  }

  return true;
}

function areChatsEqual(a: BeeperChat[], b: BeeperChat[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.accountID !== right.accountID ||
      left.title !== right.title ||
      left.lastActivity !== right.lastActivity ||
      left.unreadCount !== right.unreadCount ||
      left.lastReadMessageSortKey !== right.lastReadMessageSortKey ||
      left.isArchived !== right.isArchived ||
      left.isMuted !== right.isMuted ||
      left.isPinned !== right.isPinned
    ) {
      return false;
    }
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════

function getDemoChats(): BeeperChat[] {
  return [
    {
      id: "1",
      accountID: "whatsapp",
      title: "Sample Chat",
      type: "single",
      participants: { items: [], hasMore: false, total: 2 },
      lastActivity: new Date().toISOString(),
      unreadCount: 2,
      isArchived: false,
      isMuted: false,
      isPinned: false,
    },
    {
      id: "2",
      accountID: "whatsapp",
      title: "Alice Smith",
      type: "single",
      participants: { items: [], hasMore: false, total: 2 },
      lastActivity: new Date().toISOString(),
      unreadCount: 0,
      isArchived: false,
      isMuted: false,
      isPinned: false,
    },
    {
      id: "3",
      accountID: "whatsapp",
      title: "Family Group",
      type: "group",
      participants: { items: [], hasMore: false, total: 8 },
      lastActivity: new Date().toISOString(),
      unreadCount: 5,
      isArchived: false,
      isMuted: false,
      isPinned: true,
    },
    {
      id: "4",
      accountID: "signal",
      title: "Work Team",
      type: "group",
      participants: { items: [], hasMore: false, total: 12 },
      lastActivity: new Date().toISOString(),
      unreadCount: 1,
      isArchived: false,
      isMuted: false,
      isPinned: false,
    },
    {
      id: "5",
      accountID: "telegram",
      title: "Bob Wilson",
      type: "single",
      participants: { items: [], hasMore: false, total: 2 },
      lastActivity: new Date().toISOString(),
      unreadCount: 0,
      isArchived: false,
      isMuted: false,
      isPinned: false,
    },
    {
      id: "6",
      accountID: "whatsapp",
      title: "Mom",
      type: "single",
      participants: { items: [], hasMore: false, total: 2 },
      lastActivity: new Date().toISOString(),
      unreadCount: 1,
      isArchived: false,
      isMuted: false,
      isPinned: false,
    },
    {
      id: "7",
      accountID: "signal",
      title: "Best Friend",
      type: "single",
      participants: { items: [], hasMore: false, total: 2 },
      lastActivity: new Date().toISOString(),
      unreadCount: 3,
      isArchived: false,
      isMuted: false,
      isPinned: false,
    },
  ];
}

function getDemoMessages(): BeeperMessage[] {
  return [
    {
      id: "1",
      chatID: "1",
      accountID: "demo",
      senderID: "sample",
      senderName: "Sample Chat",
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      sortKey: "1",
      type: "TEXT",
      text: "Hey, are you coming tonight?",
      isSender: false,
      isUnread: false,
    },
    {
      id: "2",
      chatID: "1",
      accountID: "demo",
      senderID: "me",
      senderName: "You",
      timestamp: new Date(Date.now() - 3000000).toISOString(),
      sortKey: "2",
      type: "TEXT",
      text: "Yes! Around 8pm",
      isSender: true,
      isUnread: false,
    },
    {
      id: "3",
      chatID: "1",
      accountID: "demo",
      senderID: "sample",
      senderName: "Sample Chat",
      timestamp: new Date(Date.now() - 1800000).toISOString(),
      sortKey: "3",
      type: "TEXT",
      text: "Great! See you then",
      isSender: false,
      isUnread: false,
    },
    {
      id: "4",
      chatID: "1",
      accountID: "demo",
      senderID: "me",
      senderName: "You",
      timestamp: new Date(Date.now() - 600000).toISOString(),
      sortKey: "4",
      type: "TEXT",
      text: "Thanks for invite!",
      isSender: true,
      isUnread: false,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export function GlassesUI({
  beeperConfig,
  speechConfig,
}: {
  beeperConfig: { baseUrl: string; token: string } | null;
  speechConfig?: SpeechApiConfig | null;
}) {
  const [state, setState] = useState<AppState>({
    accounts: [],
    chats: [],
    messages: [],
    currentScreen: "startup",
    selectedAccount: null,
    selectedChat: null,
    selectedMessageIndex: 0,
    highlightedIndex: 0,
    isLoading: true,
    messageLoadingTimedOut: false,
    messageLoadFailed: false,
    setupRequired: false,
    messageScrollOffset: 0,
    messageDetailScrollOffset: 0,
    messageDetailImageTile: null,
    messageDetailImageStatus: "none",
    demoMode: false,
    voiceStatus: null,
    voiceTranscript: "",
    voiceAudioBytes: 0,
    startupTick: 0,
  });

  // Ref to store saved state for use in effects
  const savedStateRef = useRef<SavedState>({
    selectedAccount: null,
    selectedChat: null,
  });
  const voiceAudioChunksRef = useRef<Uint8Array[]>([]);
  const isVoiceRecordingRef = useRef<boolean>(false);
  const isVoiceTranscribingRef = useRef<boolean>(false);
  const isVoiceSendingRef = useRef<boolean>(false);
  const isVoiceCancelledRef = useRef<boolean>(false);
  const evenHubUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeOverlayEventUnsubscribeRef = useRef<(() => void) | null>(null);
  const nativeOverlayScreenRef = useRef<Screen | null>(null);

  const messagesPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const chatsPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const isMessagesPollInFlightRef = useRef<boolean>(false);
  const isChatsPollInFlightRef = useRef<boolean>(false);
  const stateRef = useRef<AppState>(state);
  const navRef = useRef<GlassNavState>({
    highlightedIndex: 0,
    screen: state.currentScreen,
  });
  const previousScreenRef = useRef<Screen>(state.currentScreen);
  // cursor position in the chat list when a chat was opened — restored on back
  const chatListIndexRef = useRef<number>(0);
  const glassesBridgeRef = useRef<EvenAppBridge | null>(null);
  const glassesInitializedRef = useRef<boolean>(false);
  const glassesLayoutRef = useRef<"text" | "chats" | "messages" | null>(null);
  const glassesTextRef = useRef<string>("");
  const glassesChatIconSignatureRef = useRef<string>("");
  const glassesChatIconsEnabledRef = useRef<boolean>(false);
  const beeperBaseRef = useRef<string | undefined>(beeperConfig?.baseUrl);
  beeperBaseRef.current = beeperConfig?.baseUrl;
  const chatFilterRef = useRef<"normal" | "low" | "archived">("normal");
  // lazy chat paging: one 25-chat page at a time; `+` marks "more exist"
  const chatCursorRef = useRef<string | null>(null);
  const chatHasMoreRef = useRef<boolean>(false);
  const chatLoadingMoreRef = useRef<boolean>(false);
  // background poll result waiting to be applied by a pull-up at the top
  const pendingChatsRef = useRef<{ chats: BeeperChat[]; cursor: string | null; hasMore: boolean } | null>(null);
  const msgBlockRef = useRef<number>(0);
  const msgFocusRef = useRef<number>(-1); // focused msg index, -1 = mic
  const micDimRef = useRef<boolean>(false);
  const videoMsgIdRef = useRef<string | null>(null);
  // older-history paging (Beeper paginates messages too; up-scroll at the
  // top of the loaded window must fetch older ones instead of dead-ending)
  const imgMsgIdRef = useRef<string | null>(null);
  const msgCursorRef = useRef<string | null>(null);
  const msgHasMoreRef = useRef<boolean>(false);
  const msgLoadingMoreRef = useRef<boolean>(false);
  const videoDurRef = useRef<number>(0);
  const videoPosRef = useRef<number>(0);
  const audioOnRef = useRef<boolean>(false);
  const speedRef = useRef<number>(1);
  const videoLoopingRef = useRef<boolean>(false);
  const msgTopNameRef = useRef<string>("");
  const msgLastContentRef = useRef<Record<number, string>>({});
  const msgSigRef = useRef<string>("");
  const chatPageSigRef = useRef<string>("");
  const chatSelSigRef = useRef<string>("");
  const chatPageRenderedAtRef = useRef<number>(0); // timestamp of last list build
  const isRenderingGlassesRef = useRef<boolean>(false);
  const pendingGlassesRenderRef = useRef<boolean>(false);
  const startupRenderCompleteRef = useRef<boolean>(false);
  const startupDelayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [navVersion, setNavVersion] = useState(0);

  // Ref to prevent duplicate message refreshes right after sending
  const suppressReloadRef = useRef<boolean>(false);
  const suppressReloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const beeper = beeperConfig ? new BeeperClient(beeperConfig) : null;

  // Latest client for the boot retry loop (config can arrive late on slow phones)
  const beeperRef = useRef<BeeperClient | null>(beeper);
  beeperRef.current = beeper;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const stopVoiceReply = useCallback(async (cancelled = false) => {
    isVoiceCancelledRef.current = cancelled;
    isVoiceRecordingRef.current = false;

    if (evenHubUnsubscribeRef.current) {
      evenHubUnsubscribeRef.current();
      evenHubUnsubscribeRef.current = null;
    }

    const bridge = await getBridge();
    if (bridge) {
      try {
        await bridge.audioControl(false);
      } catch (e) {
        console.warn("[GlassesUI] Failed to close microphone:", e);
      }
    }
  }, []);

  const stopNativeOverlayEvents = useCallback(() => {
    if (nativeOverlayEventUnsubscribeRef.current) {
      nativeOverlayEventUnsubscribeRef.current();
      nativeOverlayEventUnsubscribeRef.current = null;
    }
    nativeOverlayScreenRef.current = null;
  }, []);

  const hideNativeOverlay = useCallback(async () => {
    const hadOverlay =
      nativeOverlayScreenRef.current !== null ||
      nativeOverlayEventUnsubscribeRef.current !== null;

    stopNativeOverlayEvents();

    if (!hadOverlay) {
      return;
    }

    const bridge = await getBridge();
    if (!bridge) return;

    try {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: 0,
          listObject: [],
          textObject: [],
          imageObject: [],
        }),
      );
    } catch (e) {
      console.warn("[GlassesUI] Failed to clear native overlay:", e);
    }
  }, [stopNativeOverlayEvents]);

  const dismissVoiceReply = useCallback(async () => {
    await stopVoiceReply(true);
    await hideNativeOverlay();
    setState((s) => ({
      ...s,
      currentScreen: "messages",
      highlightedIndex: 0,
      voiceStatus: null,
      voiceTranscript: "",
      voiceAudioBytes: 0,
    }));
  }, [hideNativeOverlay, stopVoiceReply]);

  const submitVoiceReply = useCallback(async () => {
    const transcript = state.voiceTranscript.trim();
    if (!transcript || isVoiceSendingRef.current) {
      return;
    }

    isVoiceSendingRef.current = true;
    setState((s) => ({ ...s, voiceStatus: VOICE_SENDING_STATUS }));

    // Start the API request without waiting for native bridge cleanup. Bridge
    // calls can stall inside the Even WebView and previously made Send inert.
    void stopVoiceReply(false);
    const sent = await sendMessage(transcript);

    if (sent) {
      await hideNativeOverlay();
      setState((s) => ({
        ...s,
        currentScreen: "messages",
        highlightedIndex: 0,
        voiceStatus: null,
        voiceTranscript: "",
        voiceAudioBytes: 0,
      }));
    } else {
      setState((s) => ({
        ...s,
        currentScreen: "voiceReply",
        voiceStatus: VOICE_SEND_FAILED_STATUS,
      }));
    }

    isVoiceSendingRef.current = false;
  }, [hideNativeOverlay, state.voiceTranscript, stopVoiceReply]);

  const startVoiceReply = useCallback(async () => {
    if (
      !speechConfig?.baseUrl ||
      !speechConfig?.token ||
      !speechConfig?.model
    ) {
      setState((s) => ({
        ...s,
        currentScreen: "voiceReply",
        voiceStatus: VOICE_NOT_CONFIGURED_STATUS,
        voiceTranscript: "",
        voiceAudioBytes: 0,
      }));
      return;
    }

    const bridge = await getBridge();
    if (!bridge) {
      setState((s) => ({
        ...s,
        currentScreen: "voiceReply",
        voiceStatus: VOICE_MIC_UNAVAILABLE_STATUS,
        voiceTranscript: "",
        voiceAudioBytes: 0,
      }));
      return;
    }

    isVoiceCancelledRef.current = false;
    isVoiceRecordingRef.current = true;
    isVoiceTranscribingRef.current = false;
    voiceAudioChunksRef.current = [];
    setState((s) => ({
      ...s,
      currentScreen: "voiceReply",
      voiceStatus: "Listening...",
      voiceTranscript: "",
      voiceAudioBytes: 0,
    }));

    try {
      evenHubUnsubscribeRef.current = bridge.onEvenHubEvent(
        (event: EvenHubEvent) => {
          if (!event.audioEvent || !isVoiceRecordingRef.current) {
            return;
          }

          const pcm = event.audioEvent.audioPcm;
          const pcmLength = pcm?.length || 0;
          if (pcmLength === 0) {
            return;
          }

          voiceAudioChunksRef.current.push(new Uint8Array(pcm));
          setState((s) => ({
            ...s,
            voiceAudioBytes: s.voiceAudioBytes + pcmLength,
          }));
        },
      );

      const audioOpened = await bridge.audioControl(true);
      if (!audioOpened) {
        throw new Error("EvenHub microphone request was rejected");
      }
    } catch (e) {
      console.warn("[GlassesUI] Failed to open microphone:", e);
      await stopVoiceReply(true);
      setState((s) => ({
        ...s,
        currentScreen: "voiceReply",
        voiceStatus: VOICE_MIC_UNAVAILABLE_STATUS,
        voiceTranscript: "",
        voiceAudioBytes: 0,
      }));
    }
  }, [speechConfig, stopVoiceReply]);

  const finishVoiceRecording = useCallback(async () => {
    if (isVoiceTranscribingRef.current) {
      return;
    }

    if (
      !speechConfig?.baseUrl ||
      !speechConfig?.token ||
      !speechConfig?.model
    ) {
      setState((s) => ({
        ...s,
        currentScreen: "voiceReply",
        voiceStatus: VOICE_NOT_CONFIGURED_STATUS,
        voiceTranscript: "",
        voiceAudioBytes: 0,
      }));
      return;
    }

    isVoiceTranscribingRef.current = true;
    const audioChunks = voiceAudioChunksRef.current;
    await stopVoiceReply(false);

    if (audioChunks.length === 0) {
      isVoiceTranscribingRef.current = false;
      setState((s) => ({
        ...s,
        voiceStatus: "No audio captured",
        voiceTranscript: "",
      }));
      return;
    }

    setState((s) => ({
      ...s,
      voiceStatus: "Transcribing...",
      voiceTranscript: "",
    }));

    try {
      const transcript = await transcribePcmAudio(
        speechConfig,
        mergeAudioChunks(audioChunks),
      );
      if (isVoiceCancelledRef.current) {
        return;
      }

      setState((s) => ({
        ...s,
        voiceStatus: transcript ? "Ready to send" : "No speech detected",
        voiceTranscript: transcript,
      }));
    } catch (e) {
      console.warn("[GlassesUI] Failed to transcribe voice reply:", e);
      if (!isVoiceCancelledRef.current) {
        setState((s) => ({
          ...s,
          voiceStatus: VOICE_TRANSCRIPTION_FAILED_STATUS,
          voiceTranscript: "",
        }));
      }
    } finally {
      isVoiceTranscribingRef.current = false;
    }
  }, [speechConfig, stopVoiceReply]);

  const handleVoiceReplySelect = useCallback(() => {
    const currentState = stateRef.current;
    if (currentState.voiceTranscript.trim()) {
      void submitVoiceReply();
      return;
    }

    if (isVoiceRecordingRef.current) {
      void finishVoiceRecording();
      return;
    }

    if (
      currentState.voiceStatus &&
      currentState.voiceStatus !== VOICE_NOT_CONFIGURED_STATUS &&
      currentState.voiceStatus !== "Transcribing..."
    ) {
      void startVoiceReply();
    }
  }, [finishVoiceRecording, startVoiceReply, submitVoiceReply]);

  const showQuickReplyOverlay = useCallback(async () => {
    const bridge = await getBridge();
    if (!bridge) return;

    const sender = getSelectedSender(stateRef.current);
    const quickReplyTitle = `Reply to ${sender}`;
    const replyItems = buildQuickReplyItems();
    const quickReplyTitleContainer = new TextContainerProperty({
      containerID: NATIVE_REPLY_CONTAINER.QUICK_TITLE_ID,
      containerName: NATIVE_REPLY_CONTAINER.QUICK_TITLE_NAME,
      xPosition: 32,
      yPosition: 22,
      width: 512,
      height: 34,
      content: truncate(quickReplyTitle, 80),
      borderWidth: 0,
      paddingLength: 0,
      isEventCapture: 0,
    });
    const quickReplyListItems = new ListItemContainerProperty({
      itemCount: replyItems.length,
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: replyItems,
    });
    const quickReplyListContainer = new ListContainerProperty({
      containerID: NATIVE_REPLY_CONTAINER.QUICK_LIST_ID,
      containerName: NATIVE_REPLY_CONTAINER.QUICK_LIST_NAME,
      xPosition: 24,
      yPosition: 58,
      width: 528,
      height: 200,
      borderWidth: 1,
      borderColor: 15,
      borderRadius: 8,
      paddingLength: 8,
      isEventCapture: 1,
      itemContainer: quickReplyListItems,
    });

    const rebuildContainer = new RebuildPageContainer({
      containerTotalNum: 2,
      textObject: [quickReplyTitleContainer],
      listObject: [quickReplyListContainer],
      imageObject: [],
    });

    await bridge.rebuildPageContainer(rebuildContainer);

    stopNativeOverlayEvents();
    nativeOverlayScreenRef.current = "quickReply";
    nativeOverlayEventUnsubscribeRef.current = bridge.onEvenHubEvent(
      (event: EvenHubEvent) => {
        if (nativeOverlayScreenRef.current !== "quickReply") {
          return;
        }

        const action = mapGlassEvent(event);
        if (action?.type === "GO_BACK") {
          void hideNativeOverlay();
          setState((s) => ({
            ...s,
            currentScreen: "messages",
            highlightedIndex: 0,
          }));
          return;
        }

        if (!event.listEvent) {
          return;
        }

        const selectedName = event.listEvent.currentSelectItemName;
        if (!selectedName) {
          return;
        }
        if (selectedName === QUICK_REPLY_CANCEL) {
          void hideNativeOverlay();
          setState((s) => ({
            ...s,
            currentScreen: "messages",
            highlightedIndex: 0,
          }));
          return;
        }

        if (selectedName === "Voice") {
          setState((s) => ({
            ...s,
            currentScreen: "voiceReply",
            voiceStatus: "Starting mic...",
            voiceTranscript: "",
            voiceAudioBytes: 0,
          }));
          void startVoiceReply();
          return;
        }

        void hideNativeOverlay();
        sendMessage(selectedName);
        setState((s) => ({
          ...s,
          currentScreen: "messages",
          highlightedIndex: 0,
        }));
      },
    );
  }, [hideNativeOverlay, startVoiceReply, stopNativeOverlayEvents]);

  const showVoiceReplyOverlay = useCallback(async () => {
    const bridge = await getBridge();
    if (!bridge) return;

    const voiceContent = buildVoiceCardContent(state);
    const showSend = state.voiceTranscript.trim().length > 0;
    const containerTotalNum = showSend ? 2 : 1;
    const voiceCardContainer = new TextContainerProperty({
      containerID: NATIVE_REPLY_CONTAINER.VOICE_CARD_ID,
      containerName: NATIVE_REPLY_CONTAINER.VOICE_CARD_NAME,
      xPosition: 64,
      yPosition: 28,
      width: 448,
      height: 180,
      content: voiceContent,
      borderWidth: 2,
      borderColor: 15,
      borderRadius: 10,
      paddingLength: 14,
      isEventCapture: showSend ? 0 : 1,
    });
    const sendButtonItems = new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: ["Send"],
    });
    const sendButtonContainer = new ListContainerProperty({
      containerID: NATIVE_REPLY_CONTAINER.VOICE_SEND_ID,
      containerName: NATIVE_REPLY_CONTAINER.VOICE_SEND_NAME,
      xPosition: 176,
      yPosition: 218,
      width: 224,
      height: 42,
      borderWidth: 1,
      borderColor: 15,
      borderRadius: 10,
      paddingLength: 6,
      isEventCapture: 1,
      itemContainer: sendButtonItems,
    });

    const rebuildContainer = new RebuildPageContainer({
      containerTotalNum,
      textObject: [voiceCardContainer],
      listObject: showSend ? [sendButtonContainer] : [],
      imageObject: [],
    });

    await bridge.rebuildPageContainer(rebuildContainer);

    stopNativeOverlayEvents();
    nativeOverlayScreenRef.current = "voiceReply";
    nativeOverlayEventUnsubscribeRef.current = bridge.onEvenHubEvent(
      (event: EvenHubEvent) => {
        if (nativeOverlayScreenRef.current !== "voiceReply") {
          return;
        }

        const action = mapGlassEvent(event);
        if (action?.type === "GO_BACK") {
          void dismissVoiceReply();
          return;
        }

        if (action?.type === "SELECT_HIGHLIGHTED") {
          handleVoiceReplySelect();
          return;
        }

        if (
          event.listEvent &&
          event.listEvent.currentSelectItemName === "Send"
        ) {
          void submitVoiceReply();
        }
      },
    );
  }, [dismissVoiceReply, handleVoiceReplySelect, state, stopNativeOverlayEvents, submitVoiceReply]);

  const showMessageDetailOverlay = useCallback(async (msg: BeeperMessage) => {
    const bridge = await getBridge();
    if (!bridge) return;

    const fullContent = truncate(
      buildMessageDetailContent(msg),
      MESSAGE_DETAIL_UPGRADE_MAX_CHARS,
    );
    const rebuildContent = truncate(
      fullContent,
      MESSAGE_DETAIL_REBUILD_MAX_CHARS,
    );
    const imageUrl = getMessageImageUrl(msg, beeperConfig?.baseUrl);
    let imageBytes: Uint8Array | null = null;

    if (imageUrl) {
      try {
        imageBytes = await loadMessageMediaImageBytes(imageUrl);
      } catch (e) {
        console.warn("[GlassesUI] Failed to load message image:", e);
      }
    }

    const textContainer = new TextContainerProperty({
      containerID: MESSAGE_DETAIL_CONTAINER.TEXT_ID,
      containerName: MESSAGE_DETAIL_CONTAINER.TEXT_NAME,
      xPosition: 0,
      yPosition: 0,
      width: GLASSES_DISPLAY_WIDTH,
      height: GLASSES_DISPLAY_HEIGHT,
      content: rebuildContent,
      borderWidth: 0,
      borderColor: 0,
      borderRadius: 0,
      paddingLength: 6,
      isEventCapture: 1,
    });

    const rebuildContainer = new RebuildPageContainer({
      containerTotalNum: imageBytes ? 2 : 1,
      textObject: [textContainer],
      listObject: [],
      imageObject: imageBytes
        ? [
            new ImageContainerProperty({
              containerID: MESSAGE_DETAIL_CONTAINER.IMAGE_ID,
              containerName: MESSAGE_DETAIL_CONTAINER.IMAGE_NAME,
              xPosition: MESSAGE_MEDIA_IMAGE_X,
              yPosition: MESSAGE_MEDIA_IMAGE_Y,
              width: MESSAGE_MEDIA_IMAGE_WIDTH,
              height: MESSAGE_MEDIA_IMAGE_HEIGHT,
            }),
          ]
        : [],
    });

    const rebuildOk = await bridge.rebuildPageContainer(rebuildContainer);
    if (!rebuildOk) {
      console.warn("[GlassesUI] Failed to build message detail overlay");
      return;
    }

    if (imageBytes) {
      try {
        await bridge.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: MESSAGE_DETAIL_CONTAINER.IMAGE_ID,
            containerName: MESSAGE_DETAIL_CONTAINER.IMAGE_NAME,
            imageData: imageBytes,
          }),
        );
      } catch (e) {
        console.warn("[GlassesUI] Failed to send message image:", e);
      }
    }

    if (fullContent !== rebuildContent) {
      const upgradeOk = await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: MESSAGE_DETAIL_CONTAINER.TEXT_ID,
          containerName: MESSAGE_DETAIL_CONTAINER.TEXT_NAME,
          contentOffset: 0,
          contentLength: fullContent.length,
          content: fullContent,
        }),
      );
      if (!upgradeOk) {
        console.warn("[GlassesUI] Failed to upgrade message detail text");
      }
    }

    stopNativeOverlayEvents();
    nativeOverlayScreenRef.current = "messageDetail";
    const overlayOpenedAt = Date.now();
    nativeOverlayEventUnsubscribeRef.current = bridge.onEvenHubEvent(
      async (event: EvenHubEvent) => {
        if (nativeOverlayScreenRef.current !== "messageDetail") {
          return;
        }

        if (Date.now() - overlayOpenedAt < NATIVE_OVERLAY_EVENT_DEBOUNCE_MS) {
          return;
        }

        const action = mapGlassEvent(event);
        if (action?.type === "GO_BACK") {
          await hideNativeOverlay();
          setState((s) => ({ ...s, currentScreen: "messages" }));
          return;
        }

        if (action?.type === "SELECT_HIGHLIGHTED") {
          await hideNativeOverlay();
          setState((s) => ({
            ...s,
            currentScreen: "quickReply",
            highlightedIndex: 0,
            selectedMessageIndex: s.messageScrollOffset,
          }));
          navRef.current = {
            ...navRef.current,
            highlightedIndex: 0,
            screen: "quickReply",
          };
        }
      },
    );
  }, [beeperConfig?.baseUrl, hideNativeOverlay, stopNativeOverlayEvents]);

  // Demo mode: click timestamps tracked in onGlassAction
  const clickTimestamps = useRef<number[]>([]);

  useEffect(() => {
    if (state.currentScreen !== "messages" || !state.isLoading) {
      if (state.messageLoadingTimedOut) {
        setState((s) =>
          s.messageLoadingTimedOut ? { ...s, messageLoadingTimedOut: false } : s,
        );
      }
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setState((s) => {
        if (
          s.currentScreen !== "messages" ||
          !s.isLoading ||
          s.messageLoadingTimedOut
        ) {
          return s;
        }

        return {
          ...s,
          messageLoadingTimedOut: true,
        };
      });
    }, MESSAGE_LOADING_HINT_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [state.currentScreen, state.isLoading, state.selectedChat]);

  // Animate the startup loading box while it is visible
  useEffect(() => {
    if (state.currentScreen !== "startup") return;
    const id = window.setInterval(() => {
      setState((s) =>
        s.currentScreen === "startup"
          ? { ...s, startupTick: s.startupTick + 1 }
          : s,
      );
    }, 400);
    return () => window.clearInterval(id);
  }, [state.currentScreen]);

  // Load saved state and initial data
  useEffect(() => {
    async function init() {
      const startTime = Date.now();
      const MIN_STARTUP_MS = 1000;
      const CONNECT_TIMEOUT_MS = 12000; // keep retrying before "Open your phone"

      // First, load the saved state from storage
      const savedState = await loadSavedState();
      savedStateRef.current = savedState;

      // Keep startup screen visible while loading
      setState((s) => ({
        ...s,
        selectedAccount: null, // unified chat list — no per-messenger sub-view
        selectedChat: savedState.selectedChat,
        messageScrollOffset: savedState.chatScrollPosition || 0,
      }));

      // Then load data (startup screen stays visible).
      // Retry until the connect deadline: on a slow phone the Beeper config or
      // the desktop API may simply not be reachable yet at first attempt.
      let lastError: unknown = null;
      while (Date.now() - startTime < CONNECT_TIMEOUT_MS) {
        try {
          await loadData(savedState);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          await new Promise((r) => setTimeout(r, 1200));
        }
      }

      if (lastError) {
        console.warn("[GlassesUI] Beeper setup required:", lastError);
        setState((s) => ({
          ...s,
          accounts: [],
          chats: [],
          selectedChat: null,
          isLoading: false,
          setupRequired: true,
        }));
        if (savedState.selectedChat) {
          await saveState({
            selectedAccount: savedState.selectedAccount,
            selectedChat: null,
          });
        }
      }

      // Enforce minimum startup visibility so the user sees the splash
      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_STARTUP_MS) {
        await new Promise((r) => setTimeout(r, MIN_STARTUP_MS - elapsed));
      }

      // Transition to the real screen now that data is ready.
      // The unified chat list is the home screen — always land there, never
      // resume into a chat (root-page double-tap-exit must stay reachable).
      setState((s) => ({
        ...s,
        currentScreen: "chats",
        selectedChat: null,
      }));
      await saveState({
        selectedAccount: null,
        selectedChat: null,
      });
    }

    async function loadData(savedState: SavedState) {
      // Use the latest client: on a slow phone the Beeper config can arrive
      // only after the first boot attempt has already run.
      const client = beeperRef.current;
      if (!client) {
        throw new Error("Beeper is not configured");
      }

      const accounts = await client.listAccounts();

      // If we have a saved state with an account, load chats for that account first
      // Otherwise, show the chat list once configuration is valid.
      const setupRequired = accounts.length === 0;

      if (savedState.selectedChat && !setupRequired) {
        // We have a saved chat and real accounts - try to restore it.
        // Always load the UNIFIED chat list (no account filter).
        await restoreSavedChat(
          accounts,
          null,
          savedState.selectedChat,
        );
      } else {
        // No saved chat, or Beeper needs configuration.
        setState((s) => ({
          ...s,
          accounts,
          chats: [],
          isLoading: false,
          setupRequired,
        }));

        if (savedState.selectedChat && setupRequired) {
          await saveState({
            selectedAccount: savedState.selectedAccount,
            selectedChat: null,
          });
          setState((s) => ({
            ...s,
            selectedAccount: savedState.selectedAccount,
            selectedChat: null,
          }));
        }
      }
    }

    async function restoreSavedChat(
      accounts: BeeperAccount[],
      savedAccountId: string | null,
      savedChatId: string,
    ) {
      const client = beeperRef.current;
      if (!client) return;

      try {
        // Load chats for the saved account (or all chats if no specific account)
        const result = await client.listChatsUpTo(75,
          savedAccountId ? { accountIDs: [savedAccountId] } : undefined,
        );
        const loadedChats = result.chats;

        // Check if the saved chat exists in loaded chats
        const chatExists = loadedChats.some((c) => c.id === savedChatId);

        if (chatExists) {
          // Restore the chat view
          setState((s) => ({
            ...s,
            accounts,
            chats: loadedChats,
            selectedAccount: savedAccountId,
            selectedChat: savedChatId,
            highlightedIndex: 0,
            isLoading: true,
            setupRequired: false,
          }));
          void loadMessages(savedChatId);
        } else {
          // Chat no longer exists, clear saved state and show chats for the account
          await saveState({
            selectedAccount: savedAccountId,
            selectedChat: null,
          });
          setState((s) => ({
            ...s,
            accounts,
            chats: loadedChats,
            selectedAccount: savedAccountId,
            selectedChat: null,
            isLoading: false,
            setupRequired: false,
          }));
        }
      } catch (err) {
        console.error("[GlassesUI] Failed to restore saved chat:", err);
        // Fall back to the conversations list
        await saveState({
          selectedAccount: savedAccountId,
          selectedChat: null,
        });
        setState((s) => ({
          ...s,
          accounts,
          chats: [],
          selectedAccount: savedAccountId,
          selectedChat: null,
          isLoading: false,
          setupRequired: true,
        }));
      }
    }

    init();

    // Keep alive
    activateKeepAlive("even-messages");
    return () => deactivateKeepAlive();
  }, []);

  // Poll Beeper instead of relying on the desktop WebSocket.
  useEffect(() => {
    if (!beeper || state.demoMode || !state.selectedChat) return;

    const selectedChatId = state.selectedChat;

    const pollMessages = async () => {
      if (isMessagesPollInFlightRef.current) return;
      isMessagesPollInFlightRef.current = true;

      try {
        if (nativeOverlayScreenRef.current) {
          return;
        }
        if (stateRef.current.currentScreen !== "messages") {
          return;
        }
        // a looping video owns the bridge: the 1s message poll competes with
        // image sends (measured: send time tracks bridge traffic, not bytes)
        if (videoLoopingRef.current) {
          return;
        }
        if (suppressReloadRef.current) {
          return;
        }
        await loadMessages(selectedChatId, {
          preserveScroll: true,
          silent: true,
        });
      } catch (e) {
        console.warn("[GlassesUI] Message polling failed:", e);
      } finally {
        isMessagesPollInFlightRef.current = false;
      }
    };

    pollMessages();
    messagesPollIntervalRef.current = setInterval(pollMessages, 1000);

    return () => {
      if (messagesPollIntervalRef.current) {
        clearInterval(messagesPollIntervalRef.current);
        messagesPollIntervalRef.current = null;
      }
      isMessagesPollInFlightRef.current = false;
    };
  }, [beeper, state.demoMode, state.selectedChat]);

  useEffect(() => {
    if (!beeper || state.demoMode) return;

    const pollChats = async () => {
      if (isChatsPollInFlightRef.current) return;
      isChatsPollInFlightRef.current = true;

      try {
        if (nativeOverlayScreenRef.current) {
          return;
        }
        // SPARING poll (Joel 02.11.): only while sitting on page 1 / entry 1,
        // and the result is only STASHED — it gets applied when the user
        // pulls up at the top, never yanking the list around underneath them
        if (stateRef.current.currentScreen !== "chats") {
          return;
        }
        if (navRef.current.highlightedIndex !== 0) {
          return;
        }
        if (!beeper) return;
        const seq = ++chatCrawlSeq;
        const res = await beeper.listChats(
          state.selectedAccount ? { accountIDs: [state.selectedAccount] } : undefined,
        );
        if (seq !== chatCrawlSeq || !res.chats.length) return;
        if (stateRef.current.chats.length === 0) {
          // FIRST load (empty list): apply directly — stashing here left the
          // list on "No chats" forever (02.11. sim-verified bug)
          chatCursorRef.current = res.cursor ?? null;
          chatHasMoreRef.current = !!res.hasMore;
          chatPageSigRef.current = "";
          setState((st) => ({ ...st, chats: res.chats, isLoading: false, setupRequired: false }));
          return;
        }
        pendingChatsRef.current = { chats: res.chats, cursor: res.cursor ?? null, hasMore: !!res.hasMore };
      } catch (e) {
        console.warn("[GlassesUI] Chat polling failed:", e);
      } finally {
        isChatsPollInFlightRef.current = false;
      }
    };

    pollChats();
    chatsPollIntervalRef.current = setInterval(pollChats, 5000);

    return () => {
      if (chatsPollIntervalRef.current) {
        clearInterval(chatsPollIntervalRef.current);
        chatsPollIntervalRef.current = null;
      }
      isChatsPollInFlightRef.current = false;
    };
  }, [beeper, state.demoMode, state.selectedAccount]);

  useEffect(() => {
    return () => {
      stopVoiceReply(true);
    };
  }, [stopVoiceReply]);

  useEffect(() => {
    if (state.currentScreen !== "messageDetail") {
      if (state.messageDetailImageTile || state.messageDetailImageStatus !== "none") {
        setState((s) =>
          s.messageDetailImageTile || s.messageDetailImageStatus !== "none"
            ? { ...s, messageDetailImageTile: null, messageDetailImageStatus: "none" }
            : s,
        );
      }
      return;
    }

    const msg = state.messages[state.selectedMessageIndex];
    if (!msg) return;

    const imageUrl = getMessageImageUrl(msg, beeperConfig?.baseUrl);
    if (!imageUrl) {
      if (state.messageDetailImageTile || state.messageDetailImageStatus !== "none") {
        setState((s) =>
          s.messageDetailImageTile || s.messageDetailImageStatus !== "none"
            ? { ...s, messageDetailImageTile: null, messageDetailImageStatus: "none" }
            : s,
        );
      }
      return;
    }

    if (
      state.messageDetailImageTile?.messageId === msg.id &&
      state.messageDetailImageTile.url === imageUrl
    ) {
      return;
    }

    let cancelled = false;
    setState((s) =>
      s.messageDetailImageTile || s.messageDetailImageStatus !== "loading"
        ? { ...s, messageDetailImageTile: null, messageDetailImageStatus: "loading" }
        : s,
    );

    loadMessageMediaImageBytes(imageUrl)
      .then((bytes) => {
        if (cancelled) return;

        setState((s) => {
          const selected = s.messages[s.selectedMessageIndex];
          if (s.currentScreen !== "messageDetail" || selected?.id !== msg.id) {
            return s;
          }

          return bytes.length > 0
            ? {
                ...s,
                messageDetailImageTile: {
                  messageId: msg.id,
                  url: imageUrl,
                  bytes,
                },
                messageDetailImageStatus: "loaded",
              }
            : { ...s, messageDetailImageStatus: "failed" };
        });
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[GlassesUI] Failed to load message image:", e);
          setState((s) => {
            const selected = s.messages[s.selectedMessageIndex];
            if (s.currentScreen !== "messageDetail" || selected?.id !== msg.id) {
              return s;
            }

            return {
              ...s,
              messageDetailImageTile: null,
              messageDetailImageStatus: "failed",
            };
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    beeperConfig?.baseUrl,
    state.currentScreen,
    state.messageDetailImageTile,
    state.messages,
    state.selectedMessageIndex,
  ]);

  useEffect(() => {
    if (!ENABLE_CUSTOM_GLASSES_RENDERER) {
      if (nativeOverlayScreenRef.current) {
        void hideNativeOverlay();
      }
      return;
    }

    if (state.currentScreen === "quickReply") {
      void showQuickReplyOverlay();
      return;
    }

    if (state.currentScreen === "voiceReply") {
      void showVoiceReplyOverlay();
      return;
    }

    if (state.currentScreen === "messageDetail") {
      const selectedMsg = state.messages[state.selectedMessageIndex];
      if (selectedMsg) {
        void showMessageDetailOverlay(selectedMsg);
      }
      return;
    }

    if (!nativeOverlayScreenRef.current) {
      return;
    }

    void hideNativeOverlay();
  }, [
    hideNativeOverlay,
    showMessageDetailOverlay,
    showQuickReplyOverlay,
    showVoiceReplyOverlay,
    state.currentScreen,
    state.selectedMessageIndex,
    state.voiceStatus,
    state.voiceTranscript,
  ]);

  useEffect(() => {
    return () => {
      stopNativeOverlayEvents();
    };
  }, [stopNativeOverlayEvents]);

  // Persist state changes to storage
  useEffect(() => {
    const persistState = async () => {
      await saveState({
        selectedAccount: state.selectedAccount,
        selectedChat: state.selectedChat,
        chatScrollPosition: state.messageScrollOffset,
      });
    };
    persistState();
  }, [state.selectedAccount, state.selectedChat, state.messageScrollOffset]);

  // Handle selection
  // Note: highlightedIndex comes from nav state (useGlasses), not app state
  const handleSelect = useCallback(
    (s: AppState, highlightedIndex: number): Partial<AppState> => {
      const updates: Partial<AppState> = {};

      switch (s.currentScreen) {
        case "startup":
          // Ignore input while loading
          break;
        case "accounts": {
          // "All Chats" is index 0
          if (highlightedIndex === 0) {
            updates.selectedAccount = null;
          } else {
            // Find the account at this index
            const seen = new Set<string>();
            let itemIdx = 1;
            for (const account of s.accounts) {
              if (!seen.has(account.accountID)) {
                seen.add(account.accountID);
                if (itemIdx === highlightedIndex) {
                  updates.selectedAccount = account.accountID;
                  break;
                }
                itemIdx++;
              }
            }
          }
          updates.currentScreen = "chats";
          updates.highlightedIndex = 0;
          updates.isLoading = true;

          // Load chats
          void loadChats(updates.selectedAccount ?? null);
          break;
        }

        case "chats": {
          const shown = filterChats(s.chats, chatFilterRef.current);
          if (highlightedIndex < shown.length) {
            const chat = shown[highlightedIndex];
            updates.currentScreen = "messages";
            updates.selectedChat = chat.id;
            updates.isLoading = true;
            updates.messages = []; // drop previous chat's messages → no blink
            updates.selectedMessageIndex = 0;
            msgBlockRef.current = 0;
            msgFocusRef.current = -1; // focus starts on the mic
            micDimRef.current = false;
            inputHintGone = false;
            msgSigRef.current = ""; // force the messages page to rebuild on render
            // prefill the compose box from Beeper's synced draft (Joel 02.11.)
            gcSeedDraft(chat.id, (chat as { draft?: { text?: string } | null }).draft?.text);
            // messageScrollOffset will be set to max (bottom) in loadMessages

            void loadMessages(chat.id);
          }
          break;
        }

        case "messages": {
          const selectedMsg = s.messages[s.messageScrollOffset];
          if (selectedMsg) {
            updates.currentScreen = "messageDetail";
            updates.selectedMessageIndex = s.messageScrollOffset;
            updates.messageDetailScrollOffset = 0;
            updates.messageDetailImageTile = null;
            updates.messageDetailImageStatus = "none";
            if (ENABLE_CUSTOM_GLASSES_RENDERER) {
              void showMessageDetailOverlay(selectedMsg);
            }
          }
          break;
        }

        case "messageDetail": {
          updates.currentScreen = "quickReply";
          updates.highlightedIndex = 0;
          updates.messageDetailScrollOffset = 0;
          updates.messageDetailImageTile = null;
          updates.messageDetailImageStatus = "none";
          break;
        }

        case "quickReply": {
          const selectedReply = QUICK_REPLIES[highlightedIndex];
          if (!selectedReply) {
            break;
          }

          if (selectedReply === "Voice") {
            updates.currentScreen = "voiceReply";
            updates.highlightedIndex = 0;
            updates.voiceStatus = "Starting mic...";
            updates.voiceTranscript = "";
            updates.voiceAudioBytes = 0;
            void startVoiceReply();
            break;
          }

          sendMessage(selectedReply);
          updates.currentScreen = "messages";
          updates.highlightedIndex = 0;
          break;
        }

        case "voiceReply": {
          handleVoiceReplySelect();
          updates.highlightedIndex = 0;
          break;
        }
      }

      return updates;
    },
    [
      beeper,
      handleVoiceReplySelect,
      startVoiceReply,
      submitVoiceReply,
      showMessageDetailOverlay,
    ],
  );

  // Handle back
  const handleBack = useCallback(
    (s: AppState): Partial<AppState> => {
      const updates: Partial<AppState> = { highlightedIndex: 0 };

      switch (s.currentScreen) {
        case "startup":
          // Can't go back while loading
          break;
        case "accounts":
          // Can't go back
          break;
        case "chats":
          // Root level: back is handled by the exit dialog in GO_BACK
          break;
        case "messages":
          updates.currentScreen = "chats";
          updates.selectedChat = null;
          updates.messageScrollOffset = 0; // Reset scroll for next visit
          msgBlockRef.current = 0;
          break;
        case "messageDetail":
          updates.currentScreen = "messages";
          updates.messageDetailScrollOffset = 0;
          updates.messageDetailImageTile = null;
          updates.messageDetailImageStatus = "none";
          break;
        case "quickReply":
          updates.currentScreen = "messages";
          updates.voiceStatus = null;
          updates.voiceTranscript = "";
          updates.voiceAudioBytes = 0;
          break;
        case "voiceReply":
          void dismissVoiceReply();
          updates.voiceStatus = null;
          updates.voiceTranscript = "";
          updates.voiceAudioBytes = 0;
          break;
      }

      return updates;
    },
    [dismissVoiceReply],
  );

  // Load chats
  async function loadChats(
    accountId: string | null,
    options?: { silent?: boolean; preserveExisting?: boolean },
  ) {
    if (!options?.silent) {
      setState((s) => ({
        ...s,
        chats: options?.preserveExisting ? s.chats : [],
        isLoading: true,
        setupRequired: false,
      }));
    }

    if (state.demoMode) {
      const demoChats = getDemoChats();
      setState((s) => {
        const sameChats = areChatsEqual(s.chats, demoChats);
        if (sameChats && s.isLoading === false) {
          return s;
        }

        return {
          ...s,
          chats: demoChats,
          isLoading: false,
          setupRequired: false,
        };
      });
      return;
    }

    const seq = ++chatCrawlSeq;
    try {
      if (!beeper) {
        throw new Error("Beeper is not configured");
      }

      // ONE page (25) up front — the rest loads on demand at the bottom.
      // (Eagerly crawling 75 tripped the gateway rate limit and raced the
      // poll → the page count flickered and stalled at ~4 pages.)
      const result = await beeper.listChats(
        accountId ? { accountIDs: [accountId] } : undefined,
      );
      if (seq !== chatCrawlSeq) return;
      chatCursorRef.current = result.cursor ?? null;
      chatHasMoreRef.current = !!result.hasMore;
      const finalChats = result.chats;
      // PROBE (one-time): log the real fields the live API returns, so we know
      // whether avatars (participants[].imgURL) and last-message previews exist.
      if (!chatProbeDone && finalChats.length > 0) {
        chatProbeDone = true;
        const c: any = finalChats[0];
        console.log("[probe] chat keys:", Object.keys(c).join(","));
        console.log("[probe] chat.imgURL:", c.imgURL ?? "NONE");
        console.log("[probe] chat.network:", c.network ?? "NONE");
        console.log("[probe] preview.text:", c.preview?.text ? JSON.stringify(c.preview.text).slice(0, 120) : "NONE");
        const p: any = c.participants?.items?.[0];
        console.log("[probe] participant keys:", p ? Object.keys(p).join(",") : "NONE");
        console.log("[probe] imgURL:", p?.imgURL ?? "NONE");
      }
      setState((st) => {
        const sameChats = areChatsEqual(st.chats, finalChats);
        const sameLoading = options?.silent ? true : st.isLoading === false;
        const sameSetup = !st.setupRequired;
        if (sameChats && sameLoading && sameSetup) return st;
        return { ...st, chats: finalChats, isLoading: options?.silent ? st.isLoading : false, setupRequired: false };
      });
    } catch {
      // a FAILED background poll must not wipe a populated list (that flashed
      // "No chats" until the next poll restored it) — only an initial load
      // with nothing on screen yet may show the setup-required state
      if (seq !== chatCrawlSeq) return;
      setState((s) => {
        if (s.chats.length > 0) {
          const sameLoading = options?.silent ? true : s.isLoading === false;
          if (sameLoading && !s.setupRequired) return s;
          return { ...s, isLoading: options?.silent ? s.isLoading : false };
        }
        const sameLoading = options?.silent ? true : s.isLoading === false;
        const sameSetup = s.setupRequired;
        if (sameLoading && sameSetup) return s;
        return {
          ...s,
          isLoading: options?.silent ? s.isLoading : false,
          setupRequired: true,
        };
      });
    }
  }

  // fetch the next 25-chat page and append (lazy paging at the bottom)
  async function loadMoreChats() {
    // read the client from the REF: called from the memoized scroll handler,
    // whose closure `beeper` is the (still null) first-render value
    const client = beeperRef.current;
    if (!client || chatLoadingMoreRef.current || !chatCursorRef.current) return;
    chatLoadingMoreRef.current = true;
    try {
      const res = await client.listChats({ cursor: chatCursorRef.current, direction: "before" });
      if (!res.chats.length) { chatHasMoreRef.current = false; return; }
      setState((st) => {
        const seen = new Set(st.chats.map((c) => c.id));
        const merged = [...st.chats, ...res.chats.filter((c) => !seen.has(c.id))];
        return { ...st, chats: merged };
      });
      chatCursorRef.current = res.cursor ?? null;
      chatHasMoreRef.current = !!res.hasMore && !!res.cursor;
    } catch (e) {
      console.warn("[chats] loadMore failed:", String(e).slice(0, 80));
    } finally {
      chatLoadingMoreRef.current = false;
    }
  }

  // fetch the next older page of messages and prepend (up-scroll at the top).
  // NOTE: called from the memoized scroll handler → must read the client from
  // the REF (the closure's `beeper` is stale/null there, sim-verified 02.11.)
  async function loadOlderMessages(chatId: string) {
    const client = beeperRef.current;
    if (!client || msgLoadingMoreRef.current || !msgCursorRef.current) return;
    msgLoadingMoreRef.current = true;
    try {
      const res = await client.listMessages(chatId, { cursor: msgCursorRef.current, direction: "before" });
      if (!res.messages.length) { msgHasMoreRef.current = false; return; }
      const older = res.messages
        .filter((m) => (m.type || "").toUpperCase() !== "REACTION" && !(m as { isHidden?: boolean }).isHidden)
        .reverse();
      const seen = new Set(stateRef.current.messages.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      if (!fresh.length) return;
      // keep the focused message under the cursor after the prepend —
      // OUTSIDE the updater: StrictMode invokes updaters twice, a ref bump
      // inside shifted focus by 2×page and jumped to the newest message
      if (msgFocusRef.current >= 0) msgFocusRef.current += fresh.length;
      setState((st) => {
        if (st.selectedChat !== chatId) return st;
        return { ...st, messages: [...fresh, ...st.messages] };
      });
      msgCursorRef.current = res.cursor ?? null;
      msgHasMoreRef.current = !!res.hasMore && !!res.cursor;
    } catch (e) {
      console.warn("[msgs] loadOlder failed:", String(e).slice(0, 80));
    } finally {
      msgLoadingMoreRef.current = false;
    }
  }

  // Load messages
  async function loadMessages(
    chatId: string,
    options?: { preserveScroll?: boolean; silent?: boolean },
  ) {
    if (!options?.silent) {
      setState((s) => ({
        ...s,
        messages: [],
        isLoading: true,
        messageLoadingTimedOut: false,
        messageLoadFailed: false,
        setupRequired: false,
      }));
    }

    if (state.demoMode) {
      const demoMessages = getDemoMessages();
      const initialScroll = Math.max(0, demoMessages.length - 1);

      setState((s) => {
        const nextScroll = options?.preserveScroll
          ? Math.min(s.messageScrollOffset, initialScroll)
          : initialScroll;
        const sameMessages = areMessagesEqual(s.messages, demoMessages);
        const sameLoading = s.isLoading === false;
        const sameHighlight = options?.silent ? true : s.highlightedIndex === 0;
        const sameScroll = s.messageScrollOffset === nextScroll;

        if (sameMessages && sameLoading && sameHighlight && sameScroll) {
          return s;
        }

        return {
          ...s,
          messages: demoMessages,
          isLoading: false,
          messageLoadingTimedOut: false,
          messageLoadFailed: false,
          setupRequired: false,
          highlightedIndex: options?.silent ? s.highlightedIndex : 0,
          messageScrollOffset: nextScroll,
        };
      });
      return;
    }

    try {
      if (!beeper) {
        throw new Error("Beeper is not configured");
      }

      const result = await beeper.listMessages(chatId);
      // REACTION messages are not bubbles: Beeper marks them isHidden and
      // attaches the reaction to the ORIGINAL message (reactions[]). Show
      // them as a marker after the time instead of a "[media]" bubble.
      const fresh = result.messages
        .filter((m) => (m.type || "").toUpperCase() !== "REACTION" && !(m as { isHidden?: boolean }).isHidden)
        .reverse();
      // keep older messages the user already paged in above this window
      const toN = (k?: string) => Number(k ?? 0);
      const oldestNew = fresh.length ? toN(fresh[0].sortKey) : 0;
      const freshIds = new Set(fresh.map((m) => m.id));
      const keptOlder = stateRef.current.messages.filter(
        (m) => !freshIds.has(m.id) && toN(m.sortKey) < oldestNew,
      );
      const finalMessages = [...keptOlder, ...fresh];
      // only move the older-history cursor on a fresh window (a poll must not
      // rewind it, or loadOlder would re-fetch the same page forever)
      if (!keptOlder.length) {
        msgCursorRef.current = result.cursor ?? null;
        msgHasMoreRef.current = !!result.hasMore;
      }
      // keep the focused message under the cursor across the merge (by ID)
      const focusId = msgFocusRef.current >= 0 ? stateRef.current.messages[msgFocusRef.current]?.id : null;
      if (focusId) {
        const idx = finalMessages.findIndex((m) => m.id === focusId);
        if (idx >= 0) msgFocusRef.current = idx;
      }
      const initialScroll = Math.max(0, finalMessages.length - 1);

      setState((s) => {
        const nextScroll = options?.preserveScroll
          ? Math.min(s.messageScrollOffset, initialScroll)
          : initialScroll;
        const sameMessages = areMessagesEqual(s.messages, finalMessages);
        const sameLoading = options?.silent ? true : s.isLoading === false;
        const sameHighlight = options?.silent ? true : s.highlightedIndex === 0;
        const sameScroll = s.messageScrollOffset === nextScroll;

        if (sameMessages && sameLoading && sameHighlight && sameScroll) {
          return s;
        }

        return {
          ...s,
          messages: finalMessages,
          isLoading: options?.silent ? s.isLoading : false,
          messageLoadingTimedOut: options?.silent
            ? s.messageLoadingTimedOut
            : false,
          messageLoadFailed: false,
          setupRequired: false,
          highlightedIndex: options?.silent ? s.highlightedIndex : 0,
          messageScrollOffset: nextScroll,
        };
      });
    } catch {
      setState((s) => {
        const sameMessages = s.messages.length === 0;
        const sameLoading = options?.silent ? true : s.isLoading === false;
        const sameHighlight = options?.silent ? true : s.highlightedIndex === 0;
        const sameFailure = s.messageLoadFailed;

        if (sameMessages && sameLoading && sameHighlight && sameFailure) {
          return s;
        }

        return {
          ...s,
          messages: [],
          isLoading: options?.silent ? s.isLoading : false,
          messageLoadingTimedOut: options?.silent
            ? s.messageLoadingTimedOut
            : false,
          messageLoadFailed: true,
          setupRequired: true,
          highlightedIndex: options?.silent ? s.highlightedIndex : 0,
          messageScrollOffset: 0,
        };
      });
    }
  }

  // Send message
  gcBindSend(() => sendMessage);

  async function sendMessage(text: string): Promise<boolean> {
    const selectedChat = stateRef.current.selectedChat;
    if (beeper && selectedChat) {
      try {
        await beeper.sendMessage(selectedChat, { text });
        console.log("[GlassesUI] Message sent, reloading messages:", text);

        // Set suppress flag to prevent WebSocket from triggering another loadMessages
        suppressReloadRef.current = true;
        if (suppressReloadTimeoutRef.current) {
          clearTimeout(suppressReloadTimeoutRef.current);
        }
        suppressReloadTimeoutRef.current = setTimeout(() => {
          suppressReloadRef.current = false;
          suppressReloadTimeoutRef.current = null;
        }, 2000); // Suppress for 2 seconds

        // Beeper does NOT clear the draft when sending via API — do it here
        void _beeperForDraft?.updateDraft(selectedChat, null).catch(() => {});
        draftSaved = "";
        // sending returns to the input: drop video preview + reset focus to mic
        unloadVideo();
        unloadVoice();
        videoLoopingRef.current = false;
        videoMsgIdRef.current = null;
        msgFocusRef.current = -1;
        msgBlockRef.current = 0;
        micDimRef.current = false;
        void loadMessages(selectedChat);
        return true;
      } catch (e) {
        console.error("[GlassesUI] Send failed:", e);
        // Reload messages on failure to clear any pending state
        void loadMessages(selectedChat);
        return false;
      }
    } else {
      console.log("[GlassesUI] Would send:", text);
      return false;
    }
  }

  const getDisplayLines = useCallback(
    (snapshot: AppState, nav: GlassNavState): DisplayLine[] => {
      switch (snapshot.currentScreen) {
        case "accounts":
          return buildAccountsDisplay(snapshot, nav.highlightedIndex);
        case "startup":
          return buildStartupDisplay(snapshot.startupTick);
        case "chats":
          return buildChatsDisplay(snapshot, nav.highlightedIndex);
        case "messages":
          return buildMessagesDisplay(snapshot, nav.highlightedIndex);
        case "messageDetail":
          return buildMessageDetailDisplay(
            snapshot,
            snapshot.messageDetailImageTile &&
              snapshot.messageDetailImageTile.messageId ===
                snapshot.messages[snapshot.selectedMessageIndex]?.id
              ? "loaded"
              : snapshot.messageDetailImageStatus,
          );
        case "quickReply":
          return buildQuickReplyDisplay(snapshot, nav.highlightedIndex);
        case "voiceReply":
          return buildVoiceReplyDisplay(snapshot);
        default:
          return [line("GazeChat", "inverted")];
      }
    },
    [],
  );

  // Handle glass actions
  // Note: We use a ref to access latest handlers to avoid stale closure issues
  const handleSelectRef = useRef(handleSelect);
  const handleBackRef = useRef(handleBack);

  // Update refs when handlers change
  useEffect(() => {
    handleSelectRef.current = handleSelect;
  }, [handleSelect]);

  useEffect(() => {
    handleBackRef.current = handleBack;
  }, [handleBack]);

  const onGlassAction = useCallback(
    (
      action: GlassAction,
      nav: GlassNavState,
      snapshot: AppState,
    ): GlassNavState => {
      // Native overlays manage their own input lifecycle. If we also let the
      // toolkit bridge process the same gesture, actions like double-click/back
      // get handled twice and the display can end up in an invalid state.
      if (nativeOverlayScreenRef.current) {
        return nav;
      }

      switch (action.type) {
        case "HIGHLIGHT_MOVE": {
          if (snapshot.currentScreen === "messageDetail") {
            const msg = snapshot.messages[snapshot.selectedMessageIndex];
            if (!msg) return nav;

            const wrappedBody = getMessageDetailWrappedBody(msg);
            const visibleLines = Math.max(0, DISPLAY_LINES - 4);
            const maxScroll = Math.max(0, wrappedBody.length - visibleLines);
            const currentScroll = Math.min(
              snapshot.messageDetailScrollOffset,
              maxScroll,
            );

            if (action.direction === "down" && currentScroll >= maxScroll) {
              return nav;
            }
            if (action.direction === "up" && currentScroll <= 0) {
              return nav;
            }

            const nextScroll =
              currentScroll + (action.direction === "down" ? 1 : -1);
            setState((s) => ({
              ...s,
              messageDetailScrollOffset: nextScroll,
            }));
            return nav;
          }

          // Messages screen: focus starts on the mic; scrolling up moves the
          // focus message by message (full pages when paging back), down
          // returns toward the mic. Long/media messages page block by block.
          if (snapshot.currentScreen === "messages") {
            const messages = snapshot.messages;
            if (messages.length === 0) return nav;
            msgIsGroup = (snapshot.chats.find((c) => c.id === snapshot.selectedChat) as { type?: string } | undefined)?.type === "group";
            if (!inputHintGone) {
              inputHintGone = true;
              void glassesBridgeRef.current?.textContainerUpgrade(
                new TextContainerUpgrade({ containerID: 11, containerName: "input", content: " ", textColor: 0 }),
              );
            }
            const focus = Math.min(msgFocusRef.current, messages.length - 1);
            const down = action.direction === "down";
            const pages = buildMsgPages(messages);
            // mirror computeMsgLayout's override: with mic focus an oversized
            // NEWEST message is already on screen → scroll from IT, not from -1
            const eff = focus < 0 && messages.length && ownsPage(messages[messages.length - 1], messages)
              ? messages.length - 1
              : focus;
            const p = eff < 0 ? pages[0] : msgPageFor(pages, eff);
            const blocksOf = (m: BeeperMessage) =>
              isMediaMsg(m) || isVoiceMsg(m)
                ? 1
                : Math.max(1, Math.ceil(wrapToPx(msgBubbleText(m, messages), msgGeom(m.isSender).bubbleW - 14).length / MSG_MAX_LINES));
            let newFocus = eff;
            let newBlock = msgBlockRef.current;
            // block-paging only for tall TEXT (ownsPage + >1 block). A video or
            // single image owns its page but has ONE block → must use the normal
            // per-message path, else up-scroll at the page top does nothing (02.11.)
            if (eff >= 0 && ownsPage(messages[eff], messages) && blocksOf(messages[eff]) > 1) {
              // paging inside a tall focused message — block stepping works
              // with the MIC active too (the oversized newest message shows
              // its blocks dimmed; down: 1/6→…→6/6→stay, up: …→1/6→prev)
              const nb = blocksOf(messages[eff]);
              if (down) {
                if (newBlock < nb - 1) newBlock++;
                else if (focus >= 0) {
                  // past the last block: next message, or the MIC keeping the
                  // last block visible (dimmed) instead of jumping back to 1/6
                  if (eff < messages.length - 1) { newFocus = eff + 1; newBlock = 0; }
                  else { newFocus = -1; newBlock = nb - 1; }
                }
                // mic already active at the last block → no-op
              } else {
                if (newBlock > 0) newBlock--;
                else { const pi = pages.indexOf(p); newFocus = pi >= 0 && pi < pages.length - 1 ? pages[pi + 1].end : eff; }
              }
            } else if (down) {
              // walk toward the mic one message at a time so you can always
              // return to the input without re-scrolling the whole thread
              if (eff < 0) { newFocus = -1; }
              else if (eff < messages.length - 1) { newFocus = eff + 1; newBlock = 0; }
              else { newFocus = -1; } // newest message → mic
            } else {
              // up
              if (eff < 0) { newFocus = p.end; newBlock = Math.max(0, blocksOf(messages[p.end]) - 1); }
              else if (eff > p.start) { newFocus = eff - 1; newBlock = Math.max(0, blocksOf(messages[eff - 1]) - 1); }
              else {
                const pi = pages.indexOf(p);
                if (pi === pages.length - 1 && eff === 0 && msgHasMoreRef.current && snapshot.selectedChat) {
                  // top of the loaded window: pull in older messages instead
                  // of dead-ending (the video was the oldest loaded msg)
                  void loadOlderMessages(snapshot.selectedChat);
                  newFocus = eff;
                } else {
                  newFocus = pi >= 0 && pi < pages.length - 1 ? pages[pi + 1].end : eff;
                }
                newBlock = 0;
              }
            }
            // landing back on the mic only makes sense from the true newest
            if (focus < 0 && newFocus === messages.length - 1 && eff === newFocus) newFocus = -1;
            newFocus = Math.max(-1, Math.min(newFocus, messages.length - 1));
            if (newFocus !== focus || newBlock !== msgBlockRef.current) {
              msgBlockRef.current = newBlock;
              msgFocusRef.current = newFocus;
              // mic brightness swap rides without a rebuild
              const b = glassesBridgeRef.current;
              if (b && (newFocus >= 0) !== micDimRef.current) {
                micDimRef.current = newFocus >= 0;
                void b.updateImageRawData(new ImageRawDataUpdate({ containerID: 12, containerName: "mic", imageData: getMicIcon(micDimRef.current) }));
              }
              setState((s) => ({ ...s }));
            }
            return nav;
          }

          const maxIdx = getMaxIndex(snapshot, chatFilterRef.current);
          // pull UP at the very top: apply a pending poll refresh (if any)
          if (action.direction === "up" && nav.highlightedIndex === 0 && pendingChatsRef.current) {
            const pend = pendingChatsRef.current;
            pendingChatsRef.current = null;
            chatCursorRef.current = pend.cursor;
            chatHasMoreRef.current = pend.hasMore;
            setState((st) => ({ ...st, chats: pend.chats }));
            chatPageSigRef.current = ""; // force list rebuild with fresh data
            return nav;
          }
          const newIdx = Math.max(
            0,
            Math.min(
              maxIdx,
              nav.highlightedIndex + (action.direction === "down" ? 1 : -1),
            ),
          );
          // lazy paging: entering the LAST page triggers the next fetch once
          if (action.direction === "down" && chatHasMoreRef.current) {
            const shown = filterChats(snapshot.chats, chatFilterRef.current).length;
            // on the last visible page: every down-scroll checks & loads more
            if (newIdx >= shown - 5) {
              void loadMoreChats();
            }
          }
          return { ...nav, highlightedIndex: newIdx };
        }

        case "SELECT_HIGHLIGHTED": {
          // On the new messages view a tap must NOT open the legacy
          // messageDetail screen (that was the "old view" leaking through).
          // Tap on a focused VIDEO toggles the preview loop (Stufe 2).
          if (snapshot.currentScreen === "messages") {
            const msgs = snapshot.messages;
            const fi = Math.min(msgFocusRef.current, msgs.length - 1);
            const fm = fi >= 0 ? msgs[fi] : null;
            if (fm && isVoiceMsg(fm)) {
              void setupVoicePreview(fm); // no-op if already loaded
              toggleVoice();
              setState((st) => ({ ...st }));
            }
            if (fm && (fm.type || "").toUpperCase() === "VIDEO" && videoMsgIdRef.current === fm.id) {
              if (videoLoopingRef.current) {
                stopLoop();
                videoLoopingRef.current = false;
              } else {
                const vidId = fm.id;
                startLoop(async (bytes) => {
                  const b = glassesBridgeRef.current;
                  if (!b || videoMsgIdRef.current !== vidId || stateRef.current.currentScreen !== "messages") {
                    throw new Error("video preview superseded");
                  }
                  const r = await b.updateImageRawData(new ImageRawDataUpdate({ containerID: 14, containerName: "vid", imageData: bytes }));
                  return r === "success" || (r as any) === true;
                }, () => {
                  // time rides the frame: refresh the transport line right
                  // after each delivered image (deterministic 1 Hz, Joel 02.11.)
                  videoPosRef.current = videoCurrentTime();
                  setState((st) => ({ ...st }));
                });
                videoLoopingRef.current = true;
              }
              setState((st) => ({ ...st }));
            }
            return nav;
          }
          // Track clicks for demo mode easter egg
          const now = Date.now();
          clickTimestamps.current.push(now);
          clickTimestamps.current = clickTimestamps.current.filter(
            (t) => now - t < DEMO_MODE_WINDOW_MS,
          );

          // Check for 5 rapid clicks to toggle demo mode
          if (clickTimestamps.current.length >= DEMO_MODE_CLICKS) {
            clickTimestamps.current = [];
            setState((s) => {
              const newDemoMode = !s.demoMode;
              console.log(
                `[GlassesUI] Demo mode ${newDemoMode ? "ENABLED" : "DISABLED"}`,
              );
              // Reset to the conversations list when toggling demo mode
              return {
                ...s,
                demoMode: newDemoMode,
                currentScreen: "chats",
                selectedAccount: null,
                selectedChat: null,
                accounts: newDemoMode ? [] : s.accounts,
                chats: newDemoMode ? [] : s.chats,
                messages: newDemoMode ? [] : s.messages,
              };
            });
            return nav;
          }

          // Use ref to get latest handler and pass nav.highlightedIndex (source of truth)
          setState((s) => {
            const updates = handleSelectRef.current(s, nav.highlightedIndex);
            return { ...s, ...updates };
          });
          return nav;
        }

        case "GO_BACK": {
          // Even Hub submission requirement: root-page double-tap must show
          // the native exit dialogue. See page-lifecycle.md.
          // The unified chat list is the root screen now.
          if (snapshot.currentScreen === "chats" || snapshot.currentScreen === "accounts") {
            void getBridge().then((b) => b?.shutDownPageContainer(1));
            return nav;
          }
          setState((s) => {
            const updates = handleBackRef.current(s);
            return { ...s, ...updates };
          });
          return nav;
        }
      }
    },
    [], // Empty deps - we use refs to access latest handlers
  );

  const toDisplayData = useCallback(
    (snapshot: AppState, nav: GlassNavState) => ({
      lines: getDisplayLines(snapshot, nav),
    }),
    [getDisplayLines],
  );

  const getPageMode = useCallback(
    (_screen: string): "text" | "home" =>
      stateRef.current.currentScreen === "messageDetail" &&
      stateRef.current.messageDetailImageTile
        ? "home"
        : "text",
    [],
  );

  const homeImageTiles = state.messageDetailImageTile
    && state.messageDetailImageTile.bytes.length > 0
    ? [
        {
          id: MESSAGE_DETAIL_CONTAINER.IMAGE_ID,
          name: MESSAGE_DETAIL_CONTAINER.IMAGE_NAME,
          bytes: state.messageDetailImageTile.bytes,
          x: MESSAGE_MEDIA_IMAGE_X,
          y: MESSAGE_MEDIA_IMAGE_Y,
          w: MESSAGE_MEDIA_IMAGE_WIDTH,
          h: MESSAGE_MEDIA_IMAGE_HEIGHT,
        },
      ]
    : undefined;

  const ensureGlassesStartup = useCallback(async (bridge: EvenAppBridge) => {
    if (glassesInitializedRef.current) {
      return;
    }

    const startupContainer = new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [
        new TextContainerProperty({
          containerID: BASE_PAGE_CONTAINER.OVERLAY_ID,
          containerName: BASE_PAGE_CONTAINER.OVERLAY_NAME,
          xPosition: 0,
          yPosition: 0,
          width: GLASSES_DISPLAY_WIDTH,
          height: GLASSES_DISPLAY_HEIGHT,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 0,
          content: "",
          isEventCapture: 1,
        }),
        new TextContainerProperty({
          containerID: BASE_PAGE_CONTAINER.TEXT_ID,
          containerName: BASE_PAGE_CONTAINER.TEXT_NAME,
          xPosition: 0,
          yPosition: 0,
          width: GLASSES_DISPLAY_WIDTH,
          height: GLASSES_DISPLAY_HEIGHT,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 6,
          content: "GazeChat started\nPlease continue on phone",
          isEventCapture: 0,
        }),
      ],
      imageObject: [],
      listObject: [],
    });

    await bridge.createStartUpPageContainer(startupContainer);
    glassesInitializedRef.current = true;
    glassesLayoutRef.current = "text";
  }, []);

  const renderTextPage = useCallback(
    async (bridge: EvenAppBridge, text: string) => {
      if (glassesLayoutRef.current !== "text") {
        await bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: 2,
            textObject: [
              new TextContainerProperty({
                containerID: BASE_PAGE_CONTAINER.OVERLAY_ID,
                containerName: BASE_PAGE_CONTAINER.OVERLAY_NAME,
                xPosition: 0,
                yPosition: 0,
                width: GLASSES_DISPLAY_WIDTH,
                height: GLASSES_DISPLAY_HEIGHT,
                borderWidth: 0,
                borderColor: 0,
                borderRadius: 0,
                paddingLength: 0,
                content: "",
                isEventCapture: 1,
              }),
              new TextContainerProperty({
                containerID: BASE_PAGE_CONTAINER.TEXT_ID,
                containerName: BASE_PAGE_CONTAINER.TEXT_NAME,
                xPosition: 0,
                yPosition: 0,
                width: GLASSES_DISPLAY_WIDTH,
                height: GLASSES_DISPLAY_HEIGHT,
                borderWidth: 0,
                borderColor: 0,
                borderRadius: 0,
                paddingLength: 6,
                content: text,
                isEventCapture: 0,
              }),
            ],
            imageObject: [],
            listObject: [],
          }),
        );
        glassesLayoutRef.current = "text";
        glassesTextRef.current = text;
        glassesChatIconSignatureRef.current = "";
        return;
      }

      if (glassesTextRef.current === text) {
        return;
      }

      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: BASE_PAGE_CONTAINER.TEXT_ID,
          containerName: BASE_PAGE_CONTAINER.TEXT_NAME,
          contentOffset: 0,
          contentLength: text.length,
          content: text,
        }),
      );
      glassesTextRef.current = text;
    },
    [],
  );

  // voice bar ticker: 2 fps while a note plays (enough for 2.0x speed),
  // idle otherwise — the transport line rides the normal upgrade path
  useEffect(() => {
    let wasPlaying = false;
    const id = window.setInterval(() => {
      const now = voicePlaying();
      if (!now && !wasPlaying) return; // idle — no redraws
      wasPlaying = now;
      if (stateRef.current.currentScreen !== "messages") return;
      setState((st) => ({ ...st })); // re-render → bar shows new position
    }, 500);
    return () => clearInterval(id);
  }, []);

  // clock: refresh once a minute, upgrade only when the digits changed
  const clockRef = useRef<string>("");
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = clockText();
      if (t === clockRef.current) return;
      clockRef.current = t;
      if (glassesLayoutRef.current === "chats") {
        // clock is containerID 1 on the chats page
        void getBridge().then((b) =>
          b?.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: "clock", content: t })),
        );
      } else if (glassesLayoutRef.current === "messages") {
        // clock is embedded in the topbar container (clock | name)
        const lead = `${t} |`;
        const padPx = Math.max(0, 106 - textPx(lead));
        void getBridge().then((b) =>
          b?.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: "topbar", content: `${lead}${" ".repeat(Math.ceil(padPx / 6))}${msgTopNameRef.current}` })),
        );
      }
    }, 15000);
    return () => clearInterval(id);
  }, []);

  const setupVideoPreview = async (bridge: EvenAppBridge, m: BeeperMessage) => {
    unloadVideo();
    videoMsgIdRef.current = m.id;
    videoLoopingRef.current = false;
    videoDurRef.current = 0;
    const url = videoAssetUrl(m, beeperBaseRef.current);
    if (!url) return;
    const attempt = async (): Promise<boolean> => {
      try {
        const token = (await getApiConfig())?.token;
        const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (!res.ok) return false;
        const blob = await res.blob();
        const { duration } = await loadVideo(URL.createObjectURL(blob));
        videoDurRef.current = duration;
        const png = await posterFrame();
        if (png && videoMsgIdRef.current === m.id) {
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 14, containerName: "vid", imageData: png }));
          setState((st) => ({ ...st })); // re-render: duration + hint
        }
        return true;
      } catch (e) {
        console.warn("[vid] preview failed:", String(e).slice(0, 100));
        return false;
      }
    };
    if (!(await attempt()) && videoMsgIdRef.current === m.id) {
      // transient gateway hiccup (restart/rate limit): one retry after 600ms
      await new Promise((r) => setTimeout(r, 600));
      if (videoMsgIdRef.current === m.id) await attempt();
    }
  };

  const setupVoicePreview = async (m: BeeperMessage) => {
    if (voiceMsgId() === m.id) return; // already loaded for this message
    const url = voiceAssetUrl(m, beeperBaseRef.current);
    if (!url) return;
    try {
      const token = (await getApiConfig())?.token;
      await loadVoice(url, m.id, token ? { Authorization: `Bearer ${token}` } : undefined);
      setState((st) => ({ ...st })); // re-render: duration appears in the bar
    } catch (e) {
      console.warn("[voice] load failed:", String(e).slice(0, 100));
    }
  };

  const setupImagePreview = async (bridge: EvenAppBridge, m: BeeperMessage, layout: ReturnType<typeof imgLayoutFor>) => {
    imgMsgIdRef.current = m.id;
    const url = imageAssetUrl(m, beeperBaseRef.current);
    if (!url) return;
    try {
      const token = (await getApiConfig())?.token;
      const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (!res.ok) return;
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const slices = await renderImageSlices(bmp, layout);
      for (let i = 0; i < slices.length; i++) {
        if (imgMsgIdRef.current !== m.id) return; // superseded by a newer focus
        await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 15 + i, containerName: `img${i}`, imageData: slices[i] }));
      }
    } catch (e) {
      console.warn("[img] preview failed:", String(e).slice(0, 100));
    }
  };

  const renderMessagesPage = useCallback(
    async (bridge: EvenAppBridge, snapshot: AppState, _nav: GlassNavState) => {
      const chat = snapshot.chats.find((c) => c.id === snapshot.selectedChat);
      msgIsGroup = (chat as { type?: string } | undefined)?.type === "group";
      const chatName = chat ? truncatePx(chat.title, 300) : "Messages";
      const focus = Math.min(msgFocusRef.current, Math.max(0, snapshot.messages.length - 1));
      const layout = computeMsgLayout(snapshot.messages, msgBlockRef.current, snapshot.isLoading, focus);
      const items = layout.items;
      const videoFocus = layout.focus && !!items[0] && (items[0].msg.type || "").toUpperCase() === "VIDEO";
      const imgFocus = layout.focus && !!items[0] && (items[0].msg.type || "").toUpperCase() === "IMAGE";
      const voiceFocus = !!items[0] && isVoiceMsg(items[0].msg);
      // focused message = full brightness; others one step dimmer; mic dims
      // when a message holds the focus
      const slotIdx = items.map((it) => snapshot.messages.indexOf(it.msg));

      // Phone-style: incoming → time LEFT, bubble right; mine → bubble left,
      // time RIGHT. Full-width bubbles. Top bar is ONE text container
      // (clock | <spaces> name) with the avatar image overlaid on the spaces.
      const TIME_W = MSG_TIME_W, BUB_W = 574 - TIME_W - 4;
      const slots = [0, 1, 2].map((i) => {
        const it = items[i];
        if (!it) return { bubble: " ", time: " ", y: MSG_AREA_Y, h: 40, th: 40, timeY: MSG_AREA_Y, bx: 0, tx: 0, isMine: false, bright: 3, show: false };
        const isMine = !!it.msg.isSender;
        const isVid = layout.focus && (it.msg.type || "").toUpperCase() === "VIDEO";
          const tag = msgDateTag(it.msg.timestamp);
        const rx = reactionText(it.msg);
        const tstr = formatTime(it.msg.timestamp);
        const head = tag ? `${tag} ${tstr}` : tstr;
        const focused = focus === slotIdx[i];
        // the focus space rides the fit-check so it can NEVER cause a wrap:
        // one line if head+marker+space fits, else marker drops below, else
        // the old two-line stack (very wide TT.MM.JJ tags)
        const pad = focused ? " " : "";
        const timeLines = textPx(head + rx + pad) <= MSG_TIME_W - 4
          ? [head + rx]
          : textPx(head) <= MSG_TIME_W - 4
            ? [head, rx].filter(Boolean)
            : [tag, tstr + rx];
        if (it.blocks > 1) timeLines.push(`${it.block + 1}/${it.blocks}`);
        const tlines = timeLines.filter(Boolean);
        const timeTxt = tlines.join("\n") + pad;
        // natural height per message (pages are packed by height); focus mode
        // gives the single message the whole area
        const bh = layout.focus ? MSG_AREA_H : it.lines.length * MSG_LINE_H + MSG_RESERVE;
        const bx = isMine ? 0 : TIME_W + 4;
        const tx = isMine ? 574 - TIME_W : 0;
        const th = tlines.length * MSG_LINE_H + MSG_RESERVE;
        const bright = focus === slotIdx[i] ? 4 : 2;
        // firmware ignores textColor when content is identical → the focused
        // bubble gets an invisible trailing space (wrap-safe: lines break at
        // bubbleW−14, the 6px space fits in the reserve). Never do this in
        // the time container — its lines sit right at the wrap limit.
        const vidBody = isVid
          ? "\n".repeat(6) + videoTransportLine(videoPosRef.current, videoDurRef.current, videoLoopingRef.current)
          : it.lines.join("\n");
        return { bubble: vidBody + (bright === 4 ? " " : ""), time: timeTxt, y: 0, h: bh, th, timeY: 0, bx, tx, isMine, bright, show: true };
      });
      // stack slots top-down at their natural heights; center time beside bubble
      let y = MSG_AREA_Y;
      for (const s of slots) {
        if (!s.show) continue;
        s.y = y;
        s.timeY = y + Math.max(0, Math.round((s.h - s.th) / 2));
        y += s.h + MSG_GAP;
      }
      // shape = focus mode + per-slot geometry (page change → rebuild, which is
      // correct: new messages = new content); stable within a page → upgrades
      const imgLayout = imgFocus ? imgLayoutFor(attachmentAspect(items[0].msg), slots[0].bx, BUB_W) : null;
      const shape = (layout.focus ? "F" : "N") + (videoFocus ? "V" : imgFocus ? "I" + (imgLayout?.mode ?? "") : "") + slots.map((s) => (s.show ? `${s.isMine ? "m" : "i"}${s.h}:${s.y}` : "x")).join("");
      msgTopNameRef.current = chatName;
      // phone typing mirrors live into the glasses input container
      composeMirror = () => {
        const b = glassesBridgeRef.current;
        if (!b) return;
        const txt = composeText ? composeWindow() : inputHint();
        if (txt === lastMirrorTxt) return;
        lastMirrorTxt = txt;
        void b.textContainerUpgrade(new TextContainerUpgrade({ containerID: 11, containerName: "input", content: txt, textColor: composeText ? 4 : 0 }));
      };
      // pad so the name starts clear of the avatar image (x 70..104)
      const lead = `${clockText()} |`;
      const padPx = Math.max(0, 106 - textPx(lead));
      const topbarText = `${lead}${" ".repeat(Math.ceil(padPx / 6))}${chatName}`;
      const contentSig = `${slots.map((s) => s.bubble).join("|")}#${slots.map((s) => s.time).join("|")}#${topbarText}`;
      if (glassesLayoutRef.current === "messages" && msgSigRef.current === shape + "#" + contentSig) return;
      const needRebuild = glassesLayoutRef.current !== "messages" || msgSigRef.current.split("#")[0] !== shape;
      msgSigRef.current = shape + "#" + contentSig;

      const mk = (id: number, name: string, x: number, w: number, sy: number, sh: number, content: string, border: number, bright?: number, capture = false) =>
        new TextContainerProperty({ containerID: id, containerName: name, xPosition: x, yPosition: sy, width: w, height: sh, paddingLength: 2, borderWidth: border, borderColor: border ? 3 : 0, borderRadius: border ? 6 : 0, content, textColor: bright, isEventCapture: capture ? 1 : 0, zOrderIndex: id });

      const textObject = [
        new TextContainerProperty({ containerID: 1, containerName: "topbar", xPosition: 1, yPosition: 2, width: 574, height: 38, paddingLength: 2, borderWidth: 2, borderColor: 12, borderRadius: 0, content: topbarText, isEventCapture: 0, zOrderIndex: 1 }),
        mk(2, "bub0", slots[0].bx, BUB_W, slots[0].y, slots[0].h, imgFocus ? " " : slots[0].bubble, slots[0].show ? 1 : 0, slots[0].bright),
        mk(3, "time0", slots[0].tx, TIME_W, slots[0].timeY, slots[0].th, slots[0].time, 0, slots[0].bright === 4 ? 2 : 1),
        // focus mode shows ONE message → the other four slots are NOT created
        // at all; borderless parked boxes flashed as a ghost container on the
        // first open of a multi-block chat (02.11.)
        ...(layout.focus ? [] : [
          mk(4, "bub1", slots[1].bx, BUB_W, slots[1].y, slots[1].h, slots[1].bubble, slots[1].show ? 1 : 0, slots[1].bright),
          mk(5, "time1", slots[1].tx, TIME_W, slots[1].timeY, slots[1].th, slots[1].time, 0, slots[1].bright === 4 ? 2 : 1),
          mk(6, "bub2", slots[2].bx, BUB_W, slots[2].y, slots[2].h, slots[2].bubble, slots[2].show ? 1 : 0, slots[2].bright),
          mk(7, "time2", slots[2].tx, TIME_W, slots[2].timeY, slots[2].th, slots[2].time, 0, slots[2].bright === 4 ? 2 : 1),
        ]),
        new TextContainerProperty({ containerID: 11, containerName: "input", xPosition: 2, yPosition: 250, width: 534, height: 36, paddingLength: 2, borderWidth: 1, borderColor: 8, borderRadius: 0, content: composeText ? composeWindow() : inputHint(), textColor: composeText ? 4 : 0, isEventCapture: 1, zOrderIndex: 11 }),
      ];

      if (needRebuild) {
        const rb = await bridge.rebuildPageContainer(new RebuildPageContainer({
          containerTotalNum: (layout.focus ? 6 : 10) + (videoFocus ? 1 : 0) + (imgLayout ? imgLayout.boxes.length : 0),
          menuObject: new MenuContainerProperty({
            menuItems: [
              new MenuItemProperty({ itemName: "Chats", itemID: MENU_CHATS }),
              new MenuItemProperty({ itemName: "Low-Priority Chats", itemID: MENU_LOW_PRIORITY }),
              new MenuItemProperty({ itemName: "Archived Chats", itemID: MENU_ARCHIVED }),
              new MenuItemProperty({ itemName: audioOnRef.current ? "Preview-audio: on" : "Preview-Audio: off", itemID: MENU_AUDIO }),
              new MenuItemProperty({ itemName: `Playback-Speed: ${speedRef.current.toFixed(1)}`, itemID: MENU_SPEED }),
            ],
          }),
          textObject,
          imageObject: [
            new ImageContainerProperty({ containerID: 8, containerName: "topav", xPosition: 70, yPosition: 4, width: 34, height: 34, zOrderIndex: 8 }),
            new ImageContainerProperty({ containerID: 12, containerName: "mic", xPosition: 540, yPosition: 250, width: 34, height: 34, zOrderIndex: 12 }),
            ...(videoFocus ? [new ImageContainerProperty({ containerID: 14, containerName: "vid", xPosition: 143, yPosition: 46, width: VID_W, height: VID_H, zOrderIndex: 14 })] : []),
            ...(imgLayout ? imgLayout.boxes.map((b, i) => new ImageContainerProperty({ containerID: 15 + i, containerName: `img${i}`, xPosition: b.x, yPosition: b.y, width: b.w, height: b.h, zOrderIndex: 15 + i })) : []),
          ],
          listObject: [],
        }));
        glassesLayoutRef.current = "messages";
        msgLastContentRef.current = {};
        gcArmCompose(true);
        console.log("[msg] rebuild:", rb ? "ok" : "FAILED", "items", items.length, "focus", layout.focus);
        try {
          const bytes = await renderTopAvatar(chat, beeperBaseRef.current);
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 8, containerName: "topav", imageData: bytes }));
          micDimRef.current = focus >= 0;
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 12, containerName: "mic", imageData: getMicIcon(focus >= 0) }));
        } catch (e) { console.warn("[msg] top avatar failed:", e); }
        if (videoFocus) void setupVideoPreview(bridge, items[0].msg);
        else { unloadVideo(); videoLoopingRef.current = false; videoMsgIdRef.current = null; }
        if (imgFocus && imgLayout) void setupImagePreview(bridge, items[0].msg, imgLayout);
        else imgMsgIdRef.current = null;
        if (voiceFocus) void setupVoicePreview(items[0].msg);
        return;
      }
      // upgrade ONLY containers whose content actually changed — upgrading an
      // unchanged container makes the firmware nudge its internal scroll
      // [id, name, content, textColor] — brightness rides the upgrade so a
      // focus change (dim↔bright) updates without a full page rebuild
      const defs: Array<[number, string, string, number | undefined]> = [
        [1, "topbar", textObject[0].content ?? "", undefined],
        [2, "bub0", textObject[1].content ?? "", slots[0].bright],
        [3, "time0", textObject[2].content ?? "", slots[0].bright === 4 ? 2 : 1],
        ...(layout.focus ? [] : [
          [4, "bub1", textObject[3].content ?? "", slots[1].bright] as [number, string, string, number | undefined],
          [5, "time1", textObject[4].content ?? "", slots[1].bright === 4 ? 2 : 1] as [number, string, string, number | undefined],
          [6, "bub2", textObject[5].content ?? "", slots[2].bright] as [number, string, string, number | undefined],
          [7, "time2", textObject[6].content ?? "", slots[2].bright === 4 ? 2 : 1] as [number, string, string, number | undefined],
        ]),
      ];
      for (const [id, name, content, bright] of defs) {
        const key = `${content}@@${bright}`;
        if (msgLastContentRef.current[id] === key) continue;
        msgLastContentRef.current[id] = key;
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content, textColor: bright }));
      }
      if (videoFocus && videoMsgIdRef.current !== items[0].msg.id) {
        void setupVideoPreview(bridge, items[0].msg);
      } else if (videoFocus) {
        videoPosRef.current = videoCurrentTime();
      } else if (videoMsgIdRef.current) {
        unloadVideo();
        videoLoopingRef.current = false;
        videoMsgIdRef.current = null;
      }
      if (voiceFocus) void setupVoicePreview(items[0].msg);
      else if (voiceMsgId()) stopVoice(); // focus left the note → pause (keep loaded)
      if (imgFocus && imgLayout && imgMsgIdRef.current !== items[0].msg.id) {
        void setupImagePreview(bridge, items[0].msg, imgLayout);
      } else if (!imgFocus && imgMsgIdRef.current) {
        imgMsgIdRef.current = null;
      }
    },
    [],
  );

  const renderChatsPage = useCallback(
    async (bridge: EvenAppBridge, snapshot: AppState, nav: GlassNavState) => {
      // Layout B: 5 chats/page, each 2 lines (name + preview). Avatar strip
      // (avatar + messenger glyph + unread badge) on the left, sliced into 3
      // image containers (144px each). Selection marker is its own column so
      // selecting only upgrades that one container (no rebuild, no jump).
      const ROWS = 5;
      const filter = chatFilterRef.current;
      const chats = filterChats(snapshot.chats, filter);
      const total = chats.length;
      const totalPages = Math.max(1, Math.ceil(total / ROWS));
      const page = Math.max(0, Math.min(Math.floor(nav.highlightedIndex / ROWS), totalPages - 1));
      const startIdx = page * ROWS;
      const pageChats = chats.slice(startIdx, startIdx + ROWS);

      const markers = pageChats.map((_, i) => (startIdx + i === nav.highlightedIndex ? "\u25B6" : " "));
      const names = pageChats.map((c) => truncatePx(c.title, 420));
      const pageSig = `${filter}|${page}|${pageChats.map((c) => c.id).join(",")}`;
      const client = beeperRef.current;
      const fmtPrev = (raw: string) => truncatePx(stripUnsupportedChars(raw).replace(/\n/g, " ").trim(), 420);
      const prevRaw = (c: any) => ((c as any).preview?.text || "") as string;
      // NEVER block the page on a media-label fetch: use preview text or the
      // cache; unknown labels stream in via the background upgrade below
      const previews = pageChats.map((c) => {
        const raw = prevRaw(c);
        return fmtPrev(raw.trim() ? raw : mediaTypeCache.get(c.id) ?? "");
      });
      // 2 lines per chat: line1 = name, line2 = preview (blank-pad to 5 rows)
      const nameCol: string[] = [];
      const prevCol: string[] = [];
      const markCol: string[] = [];
      for (let i = 0; i < ROWS; i++) {
        nameCol.push(i < names.length ? names[i] : "");
        prevCol.push(i < previews.length ? previews[i] : "");
        markCol.push(i < markers.length ? markers[i] : " ");
      }
      // names on odd lines, previews on even lines — two containers at the
      // same x so they interleave without overlap (brightness can differ).
      // names on odd lines (1,3,5..), previews on even lines (2,4,6..) — two
      // containers at the same x interleave without overlap (brightness differs)
      const empty = total === 0;
      // media labels for chats without preview text arrive in the background
      const pending = pageChats.filter((c) => !prevRaw(c).trim() && mediaTypeCache.get(c.id) === undefined);
      if (pending.length && client) {
        void Promise.all(pending.map((c) => getMediaLabel(c, client))).then(() => {
          if (chatPageSigRef.current !== pageSig) return; // user moved on
          const fresh = pageChats.map((c) => {
            const raw = prevRaw(c);
            return fmtPrev(raw.trim() ? raw : mediaTypeCache.get(c.id) ?? "");
          });
          const txt = fresh.map((pv) => `\n${pv}`).join("\n");
          void bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 5, containerName: "preview", content: txt, textColor: 1 }));
          // keep the fill's text authoritative until the page actually changes
        }).catch(() => {});
      }
      const namesText = empty
        ? "No chats"
        : nameCol.map((n) => `${n}\n`).join("\n").replace(/\n+$/, "");
      // computed lazily: prevCol is a snapshot from the TOP of this render —
      // writing it later (after awaited upgrades) clobbered background label
      // fills that resolved in between (reactions flashed then vanished)
      const buildPrevText = () => {
        const live = pageChats.map((c) => {
          const raw = prevRaw(c);
          return fmtPrev(raw.trim() ? raw : mediaTypeCache.get(c.id) ?? "");
        });
        return empty ? " " : live.map((pv) => `\n${pv}`).join("\n");
      };
      const prevText = buildPrevText();
      // 9 lines (drop the trailing blank) so the 274px marker container never
      // overflows — overflow made the firmware scroll-jump on every upgrade
      const markerText = empty ? " " : markCol.map((m) => `${m}\n `).join("\n").replace(/\n $/, "");
      const labelText = filterLabel(filter);
      // "X/Y+" on EVERY page while more chats can be fetched (Joel spec)
      const xyRaw = `${page + 1}/${totalPages}${chatHasMoreRef.current ? "+" : ""}`;
      // center with leading spaces: (54px column - text) / 2 / 6px per space
      const xyPad = Math.max(0, Math.round((61 - textPx(xyRaw)) / 12));
      const xyText = " ".repeat(xyPad) + xyRaw;

      const selSig = `${nav.highlightedIndex}`;

      // fire-and-forget: the page text is already on the glasses when this
      // runs; a newer page supersedes an in-flight strip (seq guard), and the
      // promise chain keeps image sends strictly sequential (SDK requirement)
      const pushAvatars = () => {
        const seq = ++chatAvatarSeq;
        chatAvatarChain = chatAvatarChain.then(async () => {
          if (seq !== chatAvatarSeq) return;
          try {
            const strip = await renderAvatarStrip(pageChats, beeperBaseRef.current);
            if (seq !== chatAvatarSeq) return;
            await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 7, containerName: "av1", imageData: strip.png1 }));
            if (seq !== chatAvatarSeq) return;
            await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 8, containerName: "av2", imageData: strip.png2 }));
            if (seq !== chatAvatarSeq) return;
            await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 9, containerName: "av3", imageData: strip.png3 }));
          } catch (e) {
            console.warn("[chats] avatars failed:", String(e).slice(0, 150));
          }
        });
      };

      if (glassesLayoutRef.current !== "chats") {
        chatPageSigRef.current = pageSig;
        chatSelSigRef.current = selSig;
        chatPageRenderedAtRef.current = Date.now();
        const rb = await bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: 11,
            menuObject: new MenuContainerProperty({
              menuItems: [
                new MenuItemProperty({ itemName: "Chats", itemID: MENU_CHATS }),
                new MenuItemProperty({ itemName: "Low-Priority Chats", itemID: MENU_LOW_PRIORITY }),
                new MenuItemProperty({ itemName: "Archived Chats", itemID: MENU_ARCHIVED }),
              ],
            }),
            textObject: [
              new TextContainerProperty({ containerID: 1, containerName: "clock", xPosition: 2, yPosition: 2, width: 52, height: 34, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: clockText(), zOrderIndex: 1 }),
              new TextContainerProperty({ containerID: 2, containerName: "xy", xPosition: 2, yPosition: 250, width: 61, height: 34, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: xyText, textColor: 2, zOrderIndex: 2 }),
              new TextContainerProperty({ containerID: 3, containerName: "markers", xPosition: 56, yPosition: 14, width: 20, height: 274, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: markerText, zOrderIndex: 3 }),
              // empty scroll catcher directly BEHIND the spine logo (lowest z):
              // gestures land here, its single-space content can never scroll
              // or jump (markers column used to rubber-band as the catcher)
              new TextContainerProperty({ containerID: 13, containerName: "catcher", xPosition: 2, yPosition: 40, width: 54, height: 144, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: " ", isEventCapture: 1, zOrderIndex: 0 }),
              new TextContainerProperty({ containerID: 4, containerName: "names", xPosition: 138, yPosition: 0, width: 438, height: 288, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: namesText, zOrderIndex: 4 }),
              new TextContainerProperty({ containerID: 5, containerName: "preview", xPosition: 138, yPosition: 0, width: 438, height: 288, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: prevText, textColor: 1, zOrderIndex: 5 }),
              new TextContainerProperty({ containerID: 10, containerName: "label", xPosition: 2, yPosition: 192, width: 54, height: 56, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: labelText, textColor: 2, zOrderIndex: 10 }),
            ],
            imageObject: [
              new ImageContainerProperty({ containerID: 6, containerName: "spine", xPosition: 2, yPosition: 40, width: 54, height: 144, zOrderIndex: 6 }),
              new ImageContainerProperty({ containerID: 7, containerName: "av1", xPosition: 78, yPosition: 2, width: 56, height: 108, zOrderIndex: 7 }),
              new ImageContainerProperty({ containerID: 8, containerName: "av2", xPosition: 78, yPosition: 110, width: 56, height: 108, zOrderIndex: 8 }),
              new ImageContainerProperty({ containerID: 9, containerName: "av3", xPosition: 78, yPosition: 218, width: 56, height: 54, zOrderIndex: 9 }),
            ],
            listObject: [],
          }),
        );
        glassesLayoutRef.current = "chats";
        gcArmCompose(false);
        composeMirror = null;
        console.log("[chats] rebuild:", rb ? "ok" : "FAILED", "page", page + 1, "/", totalPages);
        try {
          const bytes = await getSpineBytes();
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 6, containerName: "spine", imageData: bytes }));
        } catch (e) { console.warn("[chats] spine failed:", e); }
        pushAvatars();
        return;
      }

      if (chatPageSigRef.current !== pageSig) {
        chatPageSigRef.current = pageSig;
        chatSelSigRef.current = selSig;
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 4, containerName: "names", content: namesText }));
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 5, containerName: "preview", content: buildPrevText() }));
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: "markers", content: markerText }));
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: "xy", content: xyText }));
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 10, containerName: "label", content: labelText }));
        pushAvatars();
        return;
      }

      if (chatSelSigRef.current !== selSig) {
        // selection moved within the page: ONLY the marker column upgrades
        chatSelSigRef.current = selSig;
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: "markers", content: markerText }));
      }
    },
    [],
  );

  const flushGlassesDisplay = useCallback(async () => {
    const bridge = glassesBridgeRef.current;
    if (!bridge) {
      return;
    }

    if (nativeOverlayScreenRef.current) {
      return;
    }

    if (isRenderingGlassesRef.current) {
      pendingGlassesRenderRef.current = true;
      return;
    }

    isRenderingGlassesRef.current = true;
    pendingGlassesRenderRef.current = false;

    try {
      await ensureGlassesStartup(bridge);

      // Delay first content render so the OS startup message is visible briefly
      if (!startupRenderCompleteRef.current) {
        if (!startupDelayTimeoutRef.current) {
          startupDelayTimeoutRef.current = setTimeout(() => {
            startupRenderCompleteRef.current = true;
            startupDelayTimeoutRef.current = null;
            void flushGlassesDisplay();
          }, STARTUP_DELAY_MS);
        }
        isRenderingGlassesRef.current = false;
        return;
      }

      const snapshot = stateRef.current;
      const nav = navRef.current;

      console.log("[flush]", snapshot.currentScreen, "loading", snapshot.isLoading, "msgs", snapshot.messages.length);
      if (snapshot.currentScreen === "chats") {
        await renderChatsPage(bridge, snapshot, nav);
      } else if (snapshot.currentScreen === "messages") {
        // keep the chat list until the first messages arrive (single switch,
        // no placeholder-frame double flash); the chats poll is paused on this
        // screen so the list can't rebuild underneath (that was the flash)
        if (snapshot.isLoading && snapshot.messages.length === 0) return;
        await renderMessagesPage(bridge, snapshot, nav);
      } else {
        const lines = getDisplayLines(snapshot, nav);
        const text = buildGlassesText(lines, false);
        await renderTextPage(bridge, text);
      }
    } catch (e) {
      console.warn("[GlassesUI] Failed to render glasses display:", e);
    } finally {
      isRenderingGlassesRef.current = false;
      if (pendingGlassesRenderRef.current) {
        pendingGlassesRenderRef.current = false;
        void flushGlassesDisplay();
      }
    }
  }, [ensureGlassesStartup, getDisplayLines, renderChatsPage, renderTextPage]);

  useEffect(() => {
    _beeperForDraft = beeper as unknown as typeof _beeperForDraft;
  }, [beeper]);

  // app close / WebView reload: best-effort draft flush
  useEffect(() => {
    const onHide = () => gcSaveDraftNow();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  useEffect(() => {
    navRef.current.screen = state.currentScreen;
  }, [state.currentScreen]);

  useEffect(() => {
    if (previousScreenRef.current !== state.currentScreen) {
      if (previousScreenRef.current === "messages" && state.currentScreen !== "messages") {
        unloadVideo();
        unloadVoice();
        videoLoopingRef.current = false;
        videoMsgIdRef.current = null;
        gcSaveDraftNow(); // leaving the chat → persist compose as draft
      }
      // remember the list cursor when diving into a chat; put it back when
      // returning (page derives from the index, so the page is restored too)
      if (previousScreenRef.current === "chats" && state.currentScreen === "messages") {
        chatListIndexRef.current = navRef.current.highlightedIndex;
      }
      navRef.current = {
        highlightedIndex: state.currentScreen === "chats" ? chatListIndexRef.current : 0,
        screen: state.currentScreen,
      };
      previousScreenRef.current = state.currentScreen;
      setNavVersion((v) => v + 1);
      return;
    }

    navRef.current = {
      ...navRef.current,
      screen: state.currentScreen,
    };
  }, [state.currentScreen]);

  useEffect(() => {
    void flushGlassesDisplay();
  }, [state, navVersion, flushGlassesDisplay]);

  useEffect(() => {
    if (!ENABLE_CUSTOM_GLASSES_RENDERER) {
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    async function initGlasses() {
      try {
        const bridge = await waitForEvenAppBridge();
        if (disposed) return;

        glassesBridgeRef.current = bridge;
        void loadSpeedPref().then((v) => { speedRef.current = v; setVoiceSpeed(v); });
        void loadAudioPref().then((on) => {
          if (on !== audioOnRef.current) {
            audioOnRef.current = on;
            setPreviewAudio(on);
            chatPageSigRef.current = "";
            msgSigRef.current = "";
            glassesLayoutRef.current = null as any;
            void flushGlassesDisplay();
          }
        });
        unsubscribe = bridge.onEvenHubEvent((event: EvenHubEvent) => {
          if (nativeOverlayScreenRef.current) {
            return;
          }

          // Even's built-in context menu: chat list filters. The bridge
          // delivers menu clicks as raw {jsonData:{itemID}} on this SDK path.
          const menuId = event.menuItemClickEvent?.itemID ?? (event as any).jsonData?.itemID;
          if (menuId != null) {
            const id = menuId;
            if (id === MENU_SPEED) {
              const next = speedRef.current >= 2 ? 0.5 : Math.round((speedRef.current + 0.5) * 10) / 10;
              speedRef.current = next;
              setVoiceSpeed(next); // live: applies to the current playback
              void persistSpeedPref(next);
              msgSigRef.current = "";
              glassesLayoutRef.current = null as any;
              void flushGlassesDisplay();
              return;
            }
            if (id === MENU_AUDIO) {
              audioOnRef.current = !audioOnRef.current;
              setPreviewAudio(audioOnRef.current);
              void persistAudioPref(audioOnRef.current);
              // force both pages to rebuild so the menu label refreshes
              chatPageSigRef.current = "";
              msgSigRef.current = "";
              glassesLayoutRef.current = null as any;
              void flushGlassesDisplay();
              return;
            }
            const next =
              id === MENU_LOW_PRIORITY ? "low" :
              id === MENU_ARCHIVED ? "archived" : "normal";
            if (chatFilterRef.current !== next) {
              chatFilterRef.current = next;
              chatPageSigRef.current = "";
              pendingChatsRef.current = null;
              chatCursorRef.current = null;
              chatHasMoreRef.current = false;
              navRef.current = { ...navRef.current, highlightedIndex: 0 };
              setNavVersion((v) => v + 1);
              void flushGlassesDisplay();
            }
            return;
          }

          const action = mapGlassEvent(event);
          if (!action) {
            return;
          }

          const snapshot = stateRef.current;
          const nextNav = onGlassAction(action, navRef.current, snapshot);
          navRef.current = {
            ...nextNav,
            screen: stateRef.current.currentScreen,
          };
          setNavVersion((v) => v + 1);
          void flushGlassesDisplay();
        });

        await ensureGlassesStartup(bridge);
        void flushGlassesDisplay();
      } catch (e) {
        console.warn("[GlassesUI] Failed to initialize glasses bridge:", e);
      }
    }

    initGlasses();
    const unbindKeyboard = bindKeyboard((action) => {
      const snapshot = stateRef.current;
      const nextNav = onGlassAction(action, navRef.current, snapshot);
      navRef.current = {
        ...nextNav,
        screen: stateRef.current.currentScreen,
      };
      setNavVersion((v) => v + 1);
      void flushGlassesDisplay();
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      unbindKeyboard();
      glassesBridgeRef.current = null;
      glassesInitializedRef.current = false;
      glassesLayoutRef.current = null;
      glassesTextRef.current = "";
      glassesChatIconSignatureRef.current = "";
      glassesChatIconsEnabledRef.current = false;
      startupRenderCompleteRef.current = false;
      if (startupDelayTimeoutRef.current) {
        clearTimeout(startupDelayTimeoutRef.current);
        startupDelayTimeoutRef.current = null;
      }
    };
  }, [ensureGlassesStartup, flushGlassesDisplay, onGlassAction]);

  if (!ENABLE_CUSTOM_GLASSES_RENDERER) {
    return (
      <ToolkitGlassesBridge
        state={state}
        currentScreen={state.currentScreen}
        toDisplayData={toDisplayData}
        onGlassAction={onGlassAction}
        getPageMode={getPageMode}
        homeImageTiles={homeImageTiles}
      />
    );
  }

  // This is a headless component - renders nothing in DOM
  return null;
}

function ToolkitGlassesBridge({
  state,
  currentScreen,
  toDisplayData,
  onGlassAction,
  getPageMode,
  homeImageTiles,
}: {
  state: AppState;
  currentScreen: Screen;
  toDisplayData: (
    snapshot: AppState,
    nav: GlassNavState,
  ) => { lines: DisplayLine[] };
  onGlassAction: (
    action: GlassAction,
    nav: GlassNavState,
    snapshot: AppState,
  ) => GlassNavState;
  getPageMode: (screen: string) => "text" | "home";
  homeImageTiles?: {
    id: number;
    name: string;
    bytes: Uint8Array;
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
}) {
  const deriveScreen = useCallback(
    (_path: string) => currentScreen,
    [currentScreen],
  );

  useGlasses({
    getSnapshot: () => state,
    toDisplayData,
    onGlassAction,
    deriveScreen,
    appName: "even-messages",
    getPageMode,
    homeImageTiles,
  });

  return null;
}

export default GlassesUI;
