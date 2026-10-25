// Players' screen. Shows exactly one image (or black) and nothing else: no text,
// no labels, no error messages. State comes from the server over WebSocket.

import { connectSocket } from "../shared/socket.ts";
import type { ScreenView } from "../shared/types.ts";
import { computeView, transformCss } from "../shared/view.ts";

const layers = Array.from(document.querySelectorAll<HTMLImageElement>("#stage .layer"));
const veil = document.getElementById("veil")!;

let front = layers[0]!;
let back = layers[1]!;
let current: ScreenView = { mode: "black", src: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
let shownSrc: string | null = null;
let pendingSrc: string | null = null;
let loadToken = 0;

function applyTransform(img: HTMLImageElement, view: ScreenView, animate: boolean): void {
  if (!img.naturalWidth) return;
  if (!animate) img.classList.add("instant");
  const v = computeView(innerWidth, innerHeight, img.naturalWidth, img.naturalHeight, view.zoom, view.focusX, view.focusY);
  img.style.transform = transformCss(v);
  if (!animate) {
    void img.offsetWidth; // commit the jump before re-enabling the transition
    img.classList.remove("instant");
  }
}

async function swapTo(src: string): Promise<void> {
  const token = ++loadToken;
  pendingSrc = src;
  const next = back;
  try {
    // Preload and decode off-screen so the crossfade never shows a half-drawn image.
    const probe = new Image();
    probe.src = src;
    await probe.decode();
    if (token !== loadToken) return;
    next.src = src;
    if (!next.complete) await next.decode();
  } catch {
    if (token === loadToken) pendingSrc = null;
    return; // keep showing the last good image
  }
  if (token !== loadToken) return;
  pendingSrc = null;
  applyTransform(next, current, false);
  next.classList.add("front");
  front.classList.remove("front");
  back = front;
  front = next;
  shownSrc = src;
  updateVeil();
  // Free the old layer once its fade-out is over (unless it was reused meanwhile).
  const old = back;
  const oldSrc = old.src;
  setTimeout(() => {
    if (old !== front && old.src === oldSrc) old.removeAttribute("src");
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
    if (view.src !== pendingSrc) void swapTo(view.src);
  } else {
    applyTransform(front, view, true);
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
