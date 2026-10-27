// Fog of war editor: paint over the image to reveal or hide parts of it.
// The DM sees the image through a translucent fog; every change goes to the
// players' screen while painting (throttled), and once more when a stroke ends.

import { drawFog, loadMask } from "../shared/fog.ts";
import { containRect } from "../shared/view.ts";

/** Longest side of the mask in pixels: enough for soft brush edges, small enough to send live. */
const MASK_MAX = 1024;
const SEND_EVERY_MS = 120;

type Mode = "reveal" | "hide";

export class FogEditor {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly fog: HTMLCanvasElement;
  private readonly cursor: HTMLElement;
  private readonly size: HTMLInputElement;
  private readonly modeButtons: HTMLButtonElement[];

  private readonly mask = document.createElement("canvas");
  private mode: Mode = "reveal";
  private itemId: string | null = null;
  private drawing = false;
  private last: { x: number; y: number } | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSent = 0;
  private dirty = false;
  private frame = 0;

  constructor(private readonly onChange: (itemId: string, mask: string) => void) {
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.dialog = $<HTMLDialogElement>("fog-editor");
    this.title = $("fog-title");
    this.stage = $("fog-stage");
    this.img = $<HTMLImageElement>("fog-img");
    this.fog = $<HTMLCanvasElement>("fog-canvas");
    this.cursor = $("fog-cursor");
    this.size = $<HTMLInputElement>("fog-size");
    this.modeButtons = [...this.dialog.querySelectorAll<HTMLButtonElement>("[data-fog-mode]")];

    for (const b of this.modeButtons) b.addEventListener("click", () => this.setMode(b.dataset.fogMode as Mode));
    $("fog-reveal-all").addEventListener("click", () => this.fill(true));
    $("fog-cover-all").addEventListener("click", () => this.fill(false));
    $("fog-done").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => this.flush());
    this.size.addEventListener("input", () => this.updateCursorSize());

    this.stage.addEventListener("pointerdown", (e) => this.down(e));
    this.stage.addEventListener("pointermove", (e) => this.move(e));
    this.stage.addEventListener("pointerup", () => this.up());
    this.stage.addEventListener("pointercancel", () => this.up());
    this.stage.addEventListener("pointerleave", () => {
      this.cursor.hidden = true;
    });
    this.dialog.addEventListener("keydown", (e) => this.key(e));
    new ResizeObserver(() => this.redraw()).observe(this.stage);
  }

  get open(): boolean {
    return this.dialog.open;
  }

  /** Open for an image. `mask` is its current fog ("" = fully covered). */
  async show(itemId: string, label: string, src: string, mask: string): Promise<void> {
    this.itemId = itemId;
    this.title.textContent = `Fog of war: ${label}`;
    this.img.src = src;
    if (!this.dialog.open) this.dialog.showModal();
    try {
      await this.img.decode();
    } catch {
      return;
    }
    const scale = Math.min(1, MASK_MAX / Math.max(this.img.naturalWidth, this.img.naturalHeight));
    this.mask.width = Math.max(1, Math.round(this.img.naturalWidth * scale));
    this.mask.height = Math.max(1, Math.round(this.img.naturalHeight * scale));
    const ctx = this.mask.getContext("2d")!;
    ctx.clearRect(0, 0, this.mask.width, this.mask.height);
    const loaded = await loadMask(mask);
    if (loaded) ctx.drawImage(loaded, 0, 0, this.mask.width, this.mask.height);
    this.setMode("reveal");
    this.redraw();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    for (const b of this.modeButtons) b.setAttribute("aria-pressed", String(b.dataset.fogMode === mode));
    this.cursor.dataset.mode = mode;
  }

  /** Image rectangle inside the stage (object-fit: contain). */
  private rect() {
    const box = this.stage.getBoundingClientRect();
    return { box, r: containRect(box.width, box.height, this.img.naturalWidth, this.img.naturalHeight) };
  }

  /** Brush radius in mask pixels: the slider is a percentage of the image's longer side. */
  private radius(): number {
    return (Number(this.size.value) / 100) * Math.max(this.mask.width, this.mask.height);
  }

  private updateCursorSize(): void {
    const { r } = this.rect();
    const scale = r.w / (this.mask.width || 1);
    const d = this.radius() * 2 * scale;
    this.cursor.style.width = this.cursor.style.height = `${d}px`;
  }

  private toMask(e: PointerEvent): { x: number; y: number; px: number; py: number } {
    const { box, r } = this.rect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    return { x: ((px - r.x) / r.w) * this.mask.width, y: ((py - r.y) / r.h) * this.mask.height, px, py };
  }

  private dab(x: number, y: number, mode: Mode): void {
    const ctx = this.mask.getContext("2d")!;
    const rad = this.radius();
    const g = ctx.createRadialGradient(x, y, rad * 0.55, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = mode === "reveal" ? "source-over" : "destination-out";
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  /** Alt (Option) paints with the other mode while held. */
  private strokeMode(e: PointerEvent): Mode {
    if (!e.altKey) return this.mode;
    return this.mode === "reveal" ? "hide" : "reveal";
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || !this.itemId) return;
    this.stage.setPointerCapture(e.pointerId);
    this.drawing = true;
    const p = this.toMask(e);
    this.last = p;
    this.dab(p.x, p.y, this.strokeMode(e));
    this.changed();
    this.placeCursor(p.px, p.py);
  }

  private move(e: PointerEvent): void {
    const p = this.toMask(e);
    this.placeCursor(p.px, p.py);
    if (!this.drawing || !this.last) return;
    // Fill the gap between pointer events so fast strokes stay continuous.
    const step = Math.max(1, this.radius() / 3);
    const dx = p.x - this.last.x;
    const dy = p.y - this.last.y;
    const n = Math.ceil(Math.hypot(dx, dy) / step);
    const mode = this.strokeMode(e);
    for (let i = 1; i <= n; i++) this.dab(this.last.x + (dx * i) / n, this.last.y + (dy * i) / n, mode);
    this.last = p;
    this.changed();
  }

  private up(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.last = null;
    this.flush();
  }

  private placeCursor(px: number, py: number): void {
    this.cursor.hidden = false;
    this.cursor.style.left = `${px}px`;
    this.cursor.style.top = `${py}px`;
  }

  private fill(reveal: boolean): void {
    const ctx = this.mask.getContext("2d")!;
    ctx.clearRect(0, 0, this.mask.width, this.mask.height);
    if (reveal) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, this.mask.width, this.mask.height);
    }
    this.changed();
    this.flush();
  }

  private key(e: KeyboardEvent): void {
    if (e.code === "BracketLeft" || e.code === "BracketRight") {
      e.preventDefault();
      const v = Number(this.size.value) + (e.code === "BracketLeft" ? -1 : 1);
      this.size.value = String(Math.min(Number(this.size.max), Math.max(Number(this.size.min), v)));
      this.updateCursorSize();
    } else if (e.code === "KeyX") {
      e.preventDefault();
      this.setMode(this.mode === "reveal" ? "hide" : "reveal");
    }
  }

  /** Redraw now (next frame) and send soon. */
  private changed(): void {
    this.dirty = true;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.redraw());
    if (this.sendTimer === undefined) {
      const wait = Math.max(0, SEND_EVERY_MS - (performance.now() - this.lastSent));
      this.sendTimer = setTimeout(() => this.flush(), wait);
    }
  }

  /** Send the current mask if it changed since the last send. */
  private flush(): void {
    clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    if (!this.dirty || !this.itemId) return;
    this.dirty = false;
    this.lastSent = performance.now();
    this.onChange(this.itemId, this.mask.toDataURL("image/png"));
  }

  private redraw(): void {
    if (!this.img.naturalWidth) return;
    const box = this.stage.getBoundingClientRect();
    drawFog(this.fog, box.width, box.height, this.img.naturalWidth, this.img.naturalHeight, this.mask);
    this.updateCursorSize();
  }
}
