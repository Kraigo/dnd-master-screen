// Players' screen. Shows exactly one image (or black) and nothing else: no text,
// no labels, no error messages. State comes from the server over WebSocket.

import { connectSocket } from "../shared/socket.ts";
import { drawFog, loadMask } from "../shared/fog.ts";
import type { FogMask, ScreenView } from "../shared/types.ts";
import { computeView, transformCss } from "../shared/view.ts";

interface Layer {
  el: HTMLElement;
  img: HTMLImageElement;
  fog: HTMLCanvasElement;
  /** Fog currently drawn on this layer (see FogMask). */
  fogMask: FogMask;
  /** Decoded mask image, kept for redraws on resize. */
  maskImg: HTMLImageElement | null;
  /** Latest fog request for this layer; older ones that finish decoding later are dropped. */
  fogToken: number;
}

const layers: Layer[] = Array.from(document.querySelectorAll<HTMLElement>("#stage .layer"), (el) => ({
  el,
  img: el.querySelector("img")!,
  fog: el.querySelector("canvas")!,
  fogMask: null,
  maskImg: null,
  fogToken: 0,
}));
const veil = document.getElementById("veil")!;

let front = layers[0]!;
let back = layers[1]!;
let current: ScreenView = { mode: "black", src: null, zoom: 1, focusX: 0.5, focusY: 0.5, fog: null };
let shownSrc: string | null = null;
let pendingSrc: string | null = null;
let loadToken = 0;

function applyTransform(layer: Layer, view: ScreenView, animate: boolean): void {
  const img = layer.img;
  if (!img.naturalWidth) return;
  if (!animate) layer.el.classList.add("instant");
  const v = computeView(innerWidth, innerHeight, img.naturalWidth, img.naturalHeight, view.zoom, view.focusX, view.focusY);
  layer.el.style.transform = transformCss(v);
  if (!animate) {
    void layer.el.offsetWidth; // commit the jump before re-enabling the transition
    layer.el.classList.remove("instant");
  }
}

function paintFog(layer: Layer): void {
  if (layer.fogMask === null) return;
  drawFog(layer.fog, innerWidth, innerHeight, layer.img.naturalWidth, layer.img.naturalHeight, layer.maskImg);
}

/** Put a fog on a layer. Covering is instant; lifting all fog fades it out. */
async function setFog(layer: Layer, mask: FogMask): Promise<boolean> {
  const token = ++layer.fogToken;
  if (mask === null) {
    layer.fogMask = null;
    layer.maskImg = null;
    layer.fog.classList.remove("covering");
    layer.fog.style.opacity = "0";
    return true;
  }
  const img = await loadMask(mask);
  if (token !== layer.fogToken) return false;
  const wasHidden = layer.fogMask === null;
  layer.fogMask = mask;
  layer.maskImg = img;
  if (wasHidden) layer.fog.classList.add("covering");
  paintFog(layer);
  layer.fog.style.opacity = "1";
  return true;
}

async function swapTo(src: string, mask: FogMask): Promise<void> {
  const token = ++loadToken;
  pendingSrc = src;
  const next = back;
  try {
    // Preload and decode off-screen so the crossfade never shows a half-drawn image.
    const probe = new Image();
    probe.src = src;
    await probe.decode();
    if (token !== loadToken) return;
    next.img.src = src;
    if (!next.img.complete) await next.img.decode();
  } catch {
    if (token === loadToken) pendingSrc = null;
    return; // keep showing the last good image
  }
  if (token !== loadToken) return;
  // The fog must be in place before the image becomes visible.
  next.fogMask = null;
  if (mask !== null) {
    next.fog.classList.add("covering");
    if (!(await setFog(next, mask))) {
      if (token === loadToken) pendingSrc = null;
      return;
    }
  } else {
    next.fog.style.opacity = "0";
  }
  if (token !== loadToken) return;
  pendingSrc = null;
  applyTransform(next, current, false);
  next.el.classList.add("front");
  front.el.classList.remove("front");
  back = front;
  front = next;
  shownSrc = src;
  updateVeil();
  // Free the old layer once its fade-out is over (unless it was reused meanwhile).
  const old = back;
  const oldSrc = old.img.src;
  setTimeout(() => {
    if (old !== front && old.img.src === oldSrc) old.img.removeAttribute("src");
  }, 700);
}

function updateVeil(): void {
  const wantVisible = current.mode === "image" && current.src !== null;
  if (!wantVisible) veil.classList.remove("open");
  else if (current.src === shownSrc) veil.classList.add("open");
  // Otherwise a new image is still loading: keep the veil as it is, so coming
  // out of black never flashes the previous picture.
}

function render(view: ScreenView): void {
  current = view;
  if (view.src && view.src !== shownSrc) {
    if (view.src !== pendingSrc) void swapTo(view.src, view.fog);
  } else {
    applyTransform(front, view, true);
    if (view.fog !== front.fogMask) void setFog(front, view.fog);
  }
  updateVeil();
}

const socket = connectSocket(
  "screen",
  (msg) => {
    const m = msg as { type?: string; view?: ScreenView };
    if (m.type === "view" && m.view) render(m.view);
  },
  () => {}, // on disconnect: keep the last frame, show nothing
  () => reportViewport(),
);

function reportViewport(): void {
  socket.send({ type: "viewport", width: innerWidth, height: innerHeight });
}

let resizeTimer = 0;
addEventListener("resize", () => {
  applyTransform(front, current, false);
  paintFog(front);
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(reportViewport, 250);
});

// Hide the cursor after a short pause.
let idleTimer = 0;
function wake(): void {
  document.documentElement.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => document.documentElement.classList.add("idle"), 2000);
}
addEventListener("mousemove", wake);
wake();

// Double-click toggles fullscreen (fallback for F11 / Ctrl+Cmd+F).
addEventListener("dblclick", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
});

// Keep the display awake during the session where the browser allows it.
let wakeLock: { release(): Promise<void> } | null = null;
async function holdWakeLock(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (nav.wakeLock && document.visibilityState === "visible") wakeLock = await nav.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void holdWakeLock();
});
void holdWakeLock();
