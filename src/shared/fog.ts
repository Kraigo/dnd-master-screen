// Fog of war and drawings, shared by the players' screen, the DM preview and the editor.
//
// A fog mask is a PNG whose opaque pixels are the revealed parts of the image, at any
// resolution (it is stretched over the image). "" means fully covered.
// A drawing (ink) is a transparent PNG stretched over the image the same way.

import { containRect } from "./view.ts";

const FOG_BASE = "#101416";

let grain: CanvasPattern | null = null;

/** Soft cloudy texture, so fog reads as "hidden" and not as part of the black letterbox. */
function fogPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (grain) return grain;
  const size = 160;
  const tile = document.createElement("canvas");
  tile.width = tile.height = size;
  const t = tile.getContext("2d");
  if (!t) return FOG_BASE;
  t.fillStyle = FOG_BASE;
  t.fillRect(0, 0, size, size);
  // A few large soft blobs, drawn wrapped around the edges so the tile repeats seamlessly.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 18 + rand() * 40;
    const a = 0.025 + rand() * 0.04;
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const g = t.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        g.addColorStop(0, `rgba(170, 180, 175, ${a})`);
        g.addColorStop(1, "rgba(170, 180, 175, 0)");
        t.fillStyle = g;
        t.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
  }
  grain = ctx.createPattern(tile, "repeat");
  return grain ?? FOG_BASE;
}

/** Decode a mask for drawing. Resolves to null for "fully covered" or an unreadable mask. */
export async function loadMask(mask: string): Promise<HTMLImageElement | null> {
  if (!mask) return null;
  const img = new Image();
  img.src = mask;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/**
 * Draw fog over the image area of a box where the image is laid out with
 * object-fit: contain. The canvas is resized to the box. `mask` = revealed parts,
 * null = everything covered. Pass natW = 0 to clear the canvas.
 */
export function drawFog(
  canvas: HTMLCanvasElement,
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
  mask: CanvasImageSource | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(boxW * dpr));
  const h = Math.max(1, Math.round(boxH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, boxH);
  if (!natW || !natH) return;
  const r = containRect(boxW, boxH, natW, natH);
  ctx.fillStyle = fogPattern(ctx);
  // One pixel of overlap so no sliver of the image shows at the edges.
  ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
  if (mask) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(mask, r.x, r.y, r.w, r.h);
    ctx.globalCompositeOperation = "source-over";
  }
}

/** Size a canvas to its box (device pixels) and clear it; returns the 2D context in CSS pixels. */
function prepare(canvas: HTMLCanvasElement, boxW: number, boxH: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(boxW * dpr));
  const h = Math.max(1, Math.round(boxH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, boxH);
  return ctx;
}

/** Draw a drawing (ink) over the image area of a box laid out with object-fit: contain. */
export function drawInk(
  canvas: HTMLCanvasElement,
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
  ink: CanvasImageSource | null,
): void {
  const ctx = prepare(canvas, boxW, boxH);
  if (!ctx || !ink || !natW || !natH) return;
  const r = containRect(boxW, boxH, natW, natH);
  ctx.drawImage(ink, r.x, r.y, r.w, r.h);
}
