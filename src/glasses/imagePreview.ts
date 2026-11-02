/**
 * Full-size image preview for the GazeChat chat view.
 *
 * Design language = the video preview: a focused photo sits INSIDE the normal
 * full-page bordered message bubble, time container beside it as always.
 * Image containers are capped at 288x144 px, so large photos use 1-2
 * containers within the bubble rect (bx..bx+bw, y44..244):
 *   aspect >= 2    → wide:   two side by side, full bubble width x 144
 *   aspect <= 1.44 → tall:   two stacked, 288 x 200 (full bubble height)
 *   otherwise      → single: one 288x144 centered in the bubble
 * The bitmap is contain-fit (never stretched), quantized to the panel's 16
 * gray levels and sliced to the exact container rectangles.
 */

export type ImgMode = "wide" | "tall" | "single";

export interface ImgLayout {
  mode: ImgMode;
  boxes: { x: number; y: number; w: number; h: number }[];
  /** full composition canvas the slices are cut from */
  canvas: { w: number; h: number };
}

const AREA_Y = 44;
const AREA_H = 200;

const INSET = 4; // keep the bubble border visible around the photo
/** @param bx bubble left edge, @param bw bubble inner width */
export function imgLayout(aspect: number, bx: number, bw: number): ImgLayout {
  const ix = bx + INSET, iw = bw - INSET * 2;
  const iy = AREA_Y + INSET, ih = AREA_H - INSET * 2;
  if (aspect >= 2) {
    const h = Math.min(144, ih);
    const y = iy + Math.round((ih - h) / 2);
    const half = Math.floor(iw / 2);
    return { mode: "wide", canvas: { w: iw, h }, boxes: [
      { x: ix, y, w: half, h },
      { x: ix + half, y, w: iw - half, h },
    ] };
  }
  if (aspect <= 1.44) {
    const w = Math.min(288, iw);
    const x = ix + Math.round((iw - w) / 2);
    const half = Math.floor(ih / 2);
    return { mode: "tall", canvas: { w, h: ih }, boxes: [
      { x, y: iy, w, h: half },
      { x, y: iy + half, w, h: ih - half },
    ] };
  }
  const w = Math.min(288, iw), h = Math.min(144, ih);
  return { mode: "single", canvas: { w, h }, boxes: [
    { x: ix + Math.round((iw - w) / 2), y: iy + Math.round((ih - h) / 2), w, h },
  ] };
}

function pngDataUrlToBytes(dataUrl: string): number[] {
  const b = atob(dataUrl.split(",")[1] || "");
  const out = new Array<number>(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** Slice a decoded bitmap into per-container PNGs matching imgLayout(). */
export async function renderImageSlices(
  bmp: ImageBitmap,
  layout: ImgLayout,
): Promise<number[][]> {
  const boxW = layout.canvas.w, boxH = layout.canvas.h;
  const scale = Math.min(boxW / bmp.width, boxH / bmp.height);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement("canvas");
  cv.width = boxW; cv.height = boxH;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, boxW, boxH);
  ctx.drawImage(bmp, (boxW - w) / 2, (boxH - h) / 2, w, h);
  // quantize to 16 gray levels (panel is 4-bit; also shrinks the PNG)
  const img = ctx.getImageData(0, 0, boxW, boxH);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) >> 4) * 17;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);

  const ox = layout.boxes[0].x;
  const oy = layout.boxes[0].y;
  const out: number[][] = [];
  for (const box of layout.boxes) {
    const c2 = document.createElement("canvas");
    c2.width = box.w; c2.height = box.h;
    c2.getContext("2d")!.drawImage(cv, box.x - ox, box.y - oy, box.w, box.h, 0, 0, box.w, box.h);
    out.push(pngDataUrlToBytes(c2.toDataURL("image/png")));
  }
  return out;
}
