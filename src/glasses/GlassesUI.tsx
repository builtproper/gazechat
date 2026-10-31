/**
 * Message Lens - Glasses UI Component
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
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { getServiceIcon, getPlatformIcon } from "./platformIcons";
import {
  pngDataUrlToBytes,
  normalizePlatform,
} from "./platformImages";
import type { SpeechApiConfig } from "../services";
import { getApiConfig } from "../services/config";

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
const glyphW = (c: string) => GLYPH_W[c] ?? 11.7;
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
const AV = 56; // avatar cell size (2 text lines tall)

function drawMonoIcon(ctx: CanvasRenderingContext2D, bitmap: readonly number[], x: number, y: number, s: number) {
  // 16x16 1-bit bitmap (2 bytes/row, MSB first) scaled to s px
  const px = s / 16;
  ctx.fillStyle = "#fff";
  for (let row = 0; row < 16; row++) {
    const b0 = bitmap[row * 2], b1 = bitmap[row * 2 + 1];
    for (let col = 0; col < 16; col++) {
      const byte = col < 8 ? b0 : b1;
      const bit = (byte >> (7 - (col % 8))) & 1;
      if (bit) ctx.fillRect(x + col * px, y + row * px, Math.ceil(px), Math.ceil(px));
    }
  }
}

const avatarCache = new Map<string, string>(); // chatId -> dataURL of composed cell

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
    const raw: string | undefined =
      chat.imgURL ||
      (chat.participants?.items || []).find((p: any) => !p.isSelf && p.imgURL)?.imgURL;
    if (raw && baseUrl) {
      const base = normalizeBeeperBaseUrl(baseUrl);
      // Beeper stores avatars as local file paths; the HTTP gateway serves
      // them via /v1/assets/serve?url=... (token-authenticated).
      const assetUrl = /^([a-zA-Z]:\\|file:\/\/)/i.test(raw)
        ? `${base}/v1/assets/serve?url=${encodeURIComponent(raw)}`
        : buildBeeperAssetUrl(base, raw);
      const token = (await getApiConfig())?.token;
      const res = await fetch(assetUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      console.log("[avatar] fetch", res.status, res.headers.get("content-type"), `${(await res.clone().blob()).size}B`, "for", (chat.title || "").slice(0, 12));
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 0) {
          const bmp = await createImageBitmap(blob);
          ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 2, 2, AV - 4, AV - 4);
          drew = true;
        }
      }
    }
  } catch { /* fall through to initials */ }
  if (!drew) {
    // initials fallback
    const name: string = chat.title || "?";
    const ini = name.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
    ctx.fillStyle = "#fff"; ctx.font = "bold 22px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ini || "?", AV / 2, AV / 2);
  }
  // messenger icon top-right
  try {
    const plat = normalizePlatform(chat.accountID || chat.network || "");
    drawMonoIcon(ctx, getPlatformIcon(plat), AV - 16, 0, 16);
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
  avatarCache.set(key, url);
  return url;
}

// strip = 5 cells stacked (56x280); returns full grayscale bytes, sliced
// into 3 image containers by the caller (144px per-container height limit).
async function renderAvatarStrip(chats: any[], baseUrl: string | undefined): Promise<Uint8Array> {
  const h = 5 * AV;
  const cv = document.createElement("canvas");
  cv.width = AV; cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, AV, h);
  for (let i = 0; i < chats.length; i++) {
    const url = await composeAvatarCell(chats[i], baseUrl);
    try {
      const img = await loadImage(url);
      ctx.drawImage(img, 0, i * AV);
    } catch {}
  }
  const rgba = ctx.getImageData(0, 0, AV, h).data;
  const gray = new Uint8Array(AV * h);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
  }
  return gray;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

function clockText(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function getMaxIndex(state: AppState): number {
  switch (state.currentScreen) {
    case "startup":
      return 0;
    case "accounts": {
      const uniqueAccounts = new Set(state.accounts.map((a) => a.accountID));
      return Math.max(0, uniqueAccounts.size); // +1 for "All Chats" at index 0
    }
    case "chats":
      return Math.max(0, state.chats.length);
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

  // Header: "Message Lens" + time (+ DEMO indicator if active)
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const title = state.demoMode ? "Lens [DEMO]" : "Message Lens";
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
  lines.push(line(buildHeaderLine("Message Lens", time), "inverted"));
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
  const glassesBridgeRef = useRef<EvenAppBridge | null>(null);
  const glassesInitializedRef = useRef<boolean>(false);
  const glassesLayoutRef = useRef<"text" | "chats" | null>(null);
  const glassesTextRef = useRef<string>("");
  const glassesChatIconSignatureRef = useRef<string>("");
  const glassesChatIconsEnabledRef = useRef<boolean>(false);
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
        const result = await client.listChats(
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
        await loadChats(state.selectedAccount, {
          silent: true,
          preserveExisting: true,
        });
      } catch (e) {
        console.warn("[GlassesUI] Chat polling failed:", e);
      } finally {
        isChatsPollInFlightRef.current = false;
      }
    };

    pollChats();
    chatsPollIntervalRef.current = setInterval(pollChats, 2000);

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
          if (highlightedIndex < s.chats.length) {
            const chat = s.chats[highlightedIndex];
            updates.currentScreen = "messages";
            updates.selectedChat = chat.id;
            updates.isLoading = true;
            updates.selectedMessageIndex = 0;
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

    try {
      if (!beeper) {
        throw new Error("Beeper is not configured");
      }

      const result = await beeper.listChats(
        accountId ? { accountIDs: [accountId] } : undefined,
      );
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
      setState((s) => {
        const sameChats = areChatsEqual(s.chats, finalChats);
        const sameLoading = options?.silent ? true : s.isLoading === false;
        const sameSetup = !s.setupRequired;

        if (sameChats && sameLoading && sameSetup) {
          return s;
        }

        return {
          ...s,
          chats: finalChats,
          isLoading: options?.silent ? s.isLoading : false,
          setupRequired: false,
        };
      });
    } catch {
      setState((s) => {
        const sameChats = s.chats.length === 0;
        const sameLoading = options?.silent ? true : s.isLoading === false;
        const sameSetup = s.setupRequired;

        if (sameChats && sameLoading && sameSetup) {
          return s;
        }

        return {
          ...s,
          chats: [],
          isLoading: options?.silent ? s.isLoading : false,
          setupRequired: true,
        };
      });
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
      const messages = result.messages.reverse();
      const finalMessages = messages;
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
          return [line("Message Lens", "inverted")];
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

          // Messages screen uses messageScrollOffset for cursor position
          if (snapshot.currentScreen === "messages") {
            const messages = snapshot.messages;
            if (messages.length === 0) return nav;

            const currentScroll = snapshot.messageScrollOffset;
            const maxScroll = Math.max(0, messages.length - 1);

            if (action.direction === "down" && currentScroll >= maxScroll) {
              return nav;
            }
            if (action.direction === "up" && currentScroll <= 0) {
              return nav;
            }

            const newScroll =
              currentScroll + (action.direction === "down" ? 1 : -1);
            setState((s) => ({ ...s, messageScrollOffset: newScroll }));
            return nav;
          }

          const maxIdx = getMaxIndex(snapshot);
          const newIdx = Math.max(
            0,
            Math.min(
              maxIdx,
              nav.highlightedIndex + (action.direction === "down" ? 1 : -1),
            ),
          );
          return { ...nav, highlightedIndex: newIdx };
        }

        case "SELECT_HIGHLIGHTED": {
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
          content: "Message Lens started\nPlease continue on phone",
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

  const renderChatsPage = useCallback(
    async (bridge: EvenAppBridge, snapshot: AppState, nav: GlassNavState) => {
      // Layout B: 5 chats/page, each 2 lines (name + preview). Avatar strip
      // (avatar + messenger glyph + unread badge) on the left, sliced into 3
      // image containers (144px each). Selection marker is its own column so
      // selecting only upgrades that one container (no rebuild, no jump).
      const ROWS = 5;
      const total = snapshot.chats.length;
      const totalPages = Math.max(1, Math.ceil(total / ROWS));
      const page = Math.max(0, Math.min(Math.floor(nav.highlightedIndex / ROWS), totalPages - 1));
      const startIdx = page * ROWS;
      const pageChats = snapshot.chats.slice(startIdx, startIdx + ROWS);

      const markers = pageChats.map((_, i) => (startIdx + i === nav.highlightedIndex ? "\u25B6" : " "));
      const names = pageChats.map((c) => truncatePx(c.title, 420));
      const previews = pageChats.map((c) => {
        const raw = ((c as any).preview?.text || "") as string;
        return truncatePx(raw.replace(/\n/g, " ").trim(), 420);
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
      const namesText = nameCol.map((n) => `${n}\n`).join("\n");
      const prevText = prevCol.map((pv) => `\n${pv}`).join("\n");
      const markerText = markCol.map((m) => `${m}\n `).join("\n");
      const xyText = `${page + 1}/${totalPages}`;

      const pageSig = `${page}|${pageChats.map((c) => c.id).join(",")}`;
      const selSig = `${nav.highlightedIndex}`;

      const pushAvatars = async () => {
        try {
          const gray = await renderAvatarStrip(pageChats, beeperConfig?.baseUrl);
          // each cell is AV*AV bytes (56×56); slice by cell index
          const slice = (fromCell: number, toCell: number) =>
            Array.from(gray.subarray(fromCell * AV * AV, toCell * AV * AV));
          // 3 containers: rows 0-1 (112px), 2-3 (112px), 4 (56px)
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 7, containerName: "av1", imageData: slice(0, 2) }));
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 8, containerName: "av2", imageData: slice(2, 4) }));
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 9, containerName: "av3", imageData: slice(4, 5) }));
        } catch (e) {
          console.warn("[chats] avatars failed:", e);
        }
      };

      if (glassesLayoutRef.current !== "chats") {
        chatPageSigRef.current = pageSig;
        chatSelSigRef.current = selSig;
        chatPageRenderedAtRef.current = Date.now();
        const rb = await bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: 9,
            textObject: [
              new TextContainerProperty({ containerID: 1, containerName: "clock", xPosition: 2, yPosition: 2, width: 52, height: 34, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: clockText(), textColor: 2, zOrderIndex: 1 }),
              new TextContainerProperty({ containerID: 2, containerName: "xy", xPosition: 2, yPosition: 250, width: 52, height: 34, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: xyText, textColor: 2, zOrderIndex: 2 }),
              new TextContainerProperty({ containerID: 3, containerName: "markers", xPosition: 56, yPosition: 0, width: 20, height: 288, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: markerText, isEventCapture: 1, zOrderIndex: 3 }),
              new TextContainerProperty({ containerID: 4, containerName: "names", xPosition: 138, yPosition: 0, width: 438, height: 288, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: namesText, zOrderIndex: 4 }),
              new TextContainerProperty({ containerID: 5, containerName: "preview", xPosition: 138, yPosition: 0, width: 438, height: 288, paddingLength: 0, borderWidth: 0, borderRadius: 0, content: prevText, textColor: 1, zOrderIndex: 5 }),
            ],
            imageObject: [
              new ImageContainerProperty({ containerID: 6, containerName: "spine", xPosition: 4, yPosition: 44, width: 48, height: 144, zOrderIndex: 6 }),
              new ImageContainerProperty({ containerID: 7, containerName: "av1", xPosition: 78, yPosition: 2, width: 56, height: 112, zOrderIndex: 7 }),
              new ImageContainerProperty({ containerID: 8, containerName: "av2", xPosition: 78, yPosition: 114, width: 56, height: 112, zOrderIndex: 8 }),
              new ImageContainerProperty({ containerID: 9, containerName: "av3", xPosition: 78, yPosition: 226, width: 56, height: 56, zOrderIndex: 9 }),
            ],
            listObject: [],
          }),
        );
        glassesLayoutRef.current = "chats";
        console.log("[chats] rebuild:", rb ? "ok" : "FAILED", "page", page + 1, "/", totalPages);
        try {
          const bytes = await getSpineBytes();
          await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 6, containerName: "spine", imageData: bytes }));
        } catch (e) { console.warn("[chats] spine failed:", e); }
        await pushAvatars();
        return;
      }

      if (chatPageSigRef.current !== pageSig) {
        chatPageSigRef.current = pageSig;
        chatSelSigRef.current = selSig;
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 4, containerName: "names", content: namesText }));
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 5, containerName: "preview", content: prevText }));
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: "markers", content: markerText }));
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: "xy", content: xyText }));
        await pushAvatars();
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

      if (snapshot.currentScreen === "chats") {
        await renderChatsPage(bridge, snapshot, nav);
      } else {
        const lines = getDisplayLines(snapshot, nav);
        const text = buildGlassesText(lines);
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
    navRef.current.screen = state.currentScreen;
  }, [state.currentScreen]);

  useEffect(() => {
    if (previousScreenRef.current !== state.currentScreen) {
      navRef.current = {
        highlightedIndex: 0,
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
        unsubscribe = bridge.onEvenHubEvent((event: EvenHubEvent) => {
          if (nativeOverlayScreenRef.current) {
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
