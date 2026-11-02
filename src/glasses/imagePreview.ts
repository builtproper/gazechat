/**
 * Full-size image preview for the GazeChat chat view.
 *
 * Image containers are capped at 288x144 px, so a focused photo fills the
 * message area (y84..244) with 1-2 containers depending on aspect ratio:
 *   aspect >= 2    → wide:   two side by side (574x144 box)
 *   aspect <= 1.44 → tall:   two stacked (288x200 box, full area)
 *   otherwise      → single: one container (288x144)
 * The bitmap is contain-fit onto the box, quantized to the panel's 16 gray
 * levels (lossless for what the display can show) and sliced to the exact
 * container rectangles.
 */

export type ImgMode = "wide" | "tall" | "single";

export interface ImgLayout {
  mode: ImgMode;
  boxes: { x: number; y: number; w: number; h: number }[];
}

/** Fixed container geometry per mode (create-time positions). */
export function imgLayout(aspect: number): ImgLayout {
  if (aspect >= 2) {
    return { mode: "wide", boxes: [
      { x: 0, y: 96, w: 287, h: 144 },
      { x: 287, y: 96, w: 287, h: 144 },
    ] };
  }
  if (aspect <= 1.44) {
    // full message-area height (y44..244): portrait photos fill much better
    return { mode: "tall", boxes: [
      { x: 143, y: 44, w: 288, h: 100 },
      { x: 143, y: 144, w: 288, h: 100 },
    ] };
  }
  return { mode: "single", boxes: [
    { x: 143, y: 92, w: 288, h: 144 },
  ] };
}

function pngDataUrlToBytes(dataUrl: string): number[] {
  const b = atob(dataUrl.split(",")[1] || "");
  const out = new Array<number>(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/**
 * Slice a decoded bitmap into per-container PNGs matching imgLayout().
 * Returns one PNG (byte array) per box.
 */
export async function renderImageSlices(
  bmp: ImageBitmap,
  layout: ImgLayout,
): Promise<number[][]> {
  const boxW = layout.mode === "wide" ? 574 : layout.mode === "tall" ? 288 : 288;
  const boxH = layout.mode === "wide" ? 144 : layout.mode === "tall" ? 200 : 144;
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

  // box origin on the full canvas (wide starts at x0/y92, tall at x143/y84…)
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
