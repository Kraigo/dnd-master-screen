// Geometry for the zoom/pan view, shared by the players' screen and the DM preview,
// so both render the exact same framing.
//
// The <img> fills its container with `object-fit: contain` and gets
// `transform-origin: 0 0; transform: translate(tx, ty) scale(zoom)`.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewTransform {
  /** Where the contained image sits inside the container at zoom 1. */
  content: Rect;
  zoom: number;
  tx: number;
  ty: number;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Rectangle occupied by an image of natW x natH laid out with object-fit: contain. */
export function containRect(boxW: number, boxH: number, natW: number, natH: number): Rect {
  if (natW <= 0 || natH <= 0 || boxW <= 0 || boxH <= 0) return { x: 0, y: 0, w: boxW, h: boxH };
  const s = Math.min(boxW / natW, boxH / natH);
  const w = natW * s;
  const h = natH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

// One axis: put the focus point in the middle, but never pull an image edge
// inside the viewport when the zoomed image is larger than it.
function axisOffset(box: number, start: number, size: number, zoom: number, focus: number): number {
  const scaled = size * zoom;
  if (scaled <= box) return (box - scaled) / 2 - start * zoom;
  const ideal = box / 2 - zoom * (start + focus * size);
  const min = box - zoom * (start + size);
  const max = -zoom * start;
  return clamp(ideal, min, max);
}

export function computeView(
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
  zoom: number,
  focusX: number,
  focusY: number,
): ViewTransform {
  const content = containRect(boxW, boxH, natW, natH);
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  return {
    content,
    zoom: z,
    tx: axisOffset(boxW, content.x, content.w, z, clamp(focusX, 0, 1)),
    ty: axisOffset(boxH, content.y, content.h, z, clamp(focusY, 0, 1)),
  };
}

export function transformCss(v: ViewTransform): string {
  return `translate(${v.tx.toFixed(2)}px, ${v.ty.toFixed(2)}px) scale(${v.zoom.toFixed(4)})`;
}

/** Inverse mapping: a point in container coordinates -> normalized image coordinates. */
export function pointToFocus(v: ViewTransform, px: number, py: number): { x: number; y: number } {
  const lx = (px - v.tx) / v.zoom;
  const ly = (py - v.ty) / v.zoom;
  return {
    x: clamp((lx - v.content.x) / v.content.w, 0, 1),
    y: clamp((ly - v.content.y) / v.content.h, 0, 1),
  };
}
