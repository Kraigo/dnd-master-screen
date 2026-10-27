// Editor for the image on screen: fog of war (reveal / hide) and a free-hand drawing
// (arrows, circles) that lies above the fog. The DM sees the image through a
// translucent fog. Nothing reaches the players' screen while editing: everything is
// applied on "Done"; "Cancel" (or Esc) discards it.

import { drawFog, loadMask } from "../shared/fog.ts";
import type { FogMask, Ink } from "../shared/types.ts";
import { containRect } from "../shared/view.ts";

/** Longest side of the fog mask: enough for soft brush edges, small enough to send quickly. */
const MASK_MAX = 1024;
/** Longest side of the drawing: finer than the fog, lines must stay crisp. */
const INK_MAX = 1600;

type Tool = "reveal" | "hide" | "draw" | "erase";

/** Starting size of each tool (slider units); every tool remembers its own. */
const DEFAULT_SIZE: Record<Tool, number> = { reveal: 7, hide: 7, draw: 3, erase: 6 };

export class FogEditor {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly fogView: HTMLCanvasElement;
  private readonly inkView: HTMLCanvasElement;
  private readonly cursor: HTMLElement;
  private readonly size: HTMLInputElement;
  private readonly toolButtons: HTMLButtonElement[];
  private readonly colors: HTMLElement;

  /** Fog mask: opaque = revealed. */
  private readonly mask = document.createElement("canvas");
  /** Drawing: transparent PNG over the image. */
  private readonly ink = document.createElement("canvas");
  private tool: Tool = "reveal";
  private sizes = { ...DEFAULT_SIZE };
  private color = "#e5484d";
  private itemId: string | null = null;
  private drawing = false;
  /** Last pointer position of the current stroke, as a fraction of the image. */
  private last: { x: number; y: number } | null = null;
  private fogDirty = false;
  private inkDirty = false;
  /** The editor is being closed with "Done" (any other close discards the changes). */
  private applying = false;
  private frame = 0;

  constructor(private readonly onApply: (itemId: string, fog: FogMask, ink: Ink) => void) {
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.dialog = $<HTMLDialogElement>("fog-editor");
    this.title = $("fog-title");
    this.stage = $("fog-stage");
    this.img = $<HTMLImageElement>("fog-img");
    this.fogView = $<HTMLCanvasElement>("fog-canvas");
    this.inkView = $<HTMLCanvasElement>("ink-canvas");
    this.cursor = $("fog-cursor");
    this.size = $<HTMLInputElement>("fog-size");
    this.colors = $("ink-colors");
    this.toolButtons = [...this.dialog.querySelectorAll<HTMLButtonElement>("[data-tool]")];

    for (const b of this.toolButtons) b.addEventListener("click", () => this.setTool(b.dataset.tool as Tool));
    for (const b of this.colors.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      b.addEventListener("click", () => this.setColor(b.dataset.color!));
    }
    $("fog-reveal-all").addEventListener("click", () => this.fillFog(true));
    $("fog-cover-all").addEventListener("click", () => this.fillFog(false));
    $("ink-clear").addEventListener("click", () => this.clearInk());
    $("fog-done").addEventListener("click", () => {
      this.applying = true;
      this.dialog.close();
    });
    $("fog-cancel").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => this.close());
    this.size.addEventListener("input", () => {
      this.sizes[this.tool] = Number(this.size.value);
      this.updateCursorSize();
    });

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

  /** Open for an image with its current fog (null = none, "" = fully covered) and drawing. */
  async show(itemId: string, label: string, src: string, fog: FogMask, ink: Ink): Promise<void> {
    this.itemId = itemId;
    this.title.textContent = `Draw & fog: ${label}`;
    this.img.src = src;
    if (!this.dialog.open) this.dialog.showModal();
    try {
      await this.img.decode();
    } catch {
      return;
    }
    const natW = this.img.naturalWidth;
    const natH = this.img.naturalHeight;
    const fit = (c: HTMLCanvasElement, max: number) => {
      const scale = Math.min(1, max / Math.max(natW, natH));
      c.width = Math.max(1, Math.round(natW * scale));
      c.height = Math.max(1, Math.round(natH * scale));
      return c.getContext("2d")!;
    };

    const m = fit(this.mask, MASK_MAX);
    m.clearRect(0, 0, this.mask.width, this.mask.height);
    if (fog === null) {
      // No fog yet: everything is revealed until the DM hides something.
      m.fillStyle = "#fff";
      m.fillRect(0, 0, this.mask.width, this.mask.height);
    } else {
      const loaded = await loadMask(fog);
      if (loaded) m.drawImage(loaded, 0, 0, this.mask.width, this.mask.height);
    }

    const k = fit(this.ink, INK_MAX);
    k.clearRect(0, 0, this.ink.width, this.ink.height);
    const loadedInk = ink ? await loadMask(ink) : null;
    if (loadedInk) k.drawImage(loadedInk, 0, 0, this.ink.width, this.ink.height);

    this.fogDirty = false;
    this.inkDirty = false;
    this.applying = false;
    // An image without fog most likely gets a drawing; a fogged one gets revealed.
    this.setTool(fog === null ? "draw" : "reveal");
    this.redraw();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    for (const b of this.toolButtons) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    this.colors.setAttribute("aria-disabled", String(tool !== "draw"));
    this.size.value = String(this.sizes[tool]);
    this.cursor.dataset.mode = tool;
    this.updateCursorSize();
  }

  private setColor(color: string): void {
    this.color = color;
    for (const b of this.colors.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      b.setAttribute("aria-pressed", String(b.dataset.color === color));
    }
    this.cursor.style.setProperty("--ink", color);
    this.setTool("draw");
  }

  /** Image rectangle inside the stage (object-fit: contain). */
  private rect() {
    const box = this.stage.getBoundingClientRect();
    return { box, r: containRect(box.width, box.height, this.img.naturalWidth, this.img.naturalHeight) };
  }

  /** Canvas the tool paints on. */
  private target(tool: Tool): HTMLCanvasElement {
    return tool === "reveal" || tool === "hide" ? this.mask : this.ink;
  }

  /** Brush radius (for the pen: half the line width) in pixels of the tool's canvas. */
  private radius(tool: Tool): number {
    const c = this.target(tool);
    const long = Math.max(c.width, c.height);
    const v = this.sizes[tool];
    if (tool === "draw") return (v * long) / 800;
    if (tool === "erase") return (v * long) / 300;
    return (v / 100) * long; // fog brushes: percent of the longer side
  }

  private updateCursorSize(): void {
    const { r } = this.rect();
    const c = this.target(this.tool);
    const scale = r.w / (c.width || 1);
    const d = Math.max(4, this.radius(this.tool) * 2 * scale);
    this.cursor.style.width = this.cursor.style.height = `${d}px`;
  }

  /** Pointer position in stage pixels and as a fraction of the image. */
  private locate(e: PointerEvent): { fx: number; fy: number; px: number; py: number } {
    const { box, r } = this.rect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    return { fx: (px - r.x) / r.w, fy: (py - r.y) / r.h, px, py };
  }

  /** Alt (Option) paints with the opposite tool while held. */
  private strokeTool(e: PointerEvent): Tool {
    if (!e.altKey) return this.tool;
    const opposite: Record<Tool, Tool> = { reveal: "hide", hide: "reveal", draw: "erase", erase: "draw" };
    return opposite[this.tool];
  }

  private fogDab(x: number, y: number, tool: Tool): void {
    const ctx = this.mask.getContext("2d")!;
    const rad = this.radius(tool);
    const g = ctx.createRadialGradient(x, y, rad * 0.55, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = tool === "reveal" ? "source-over" : "destination-out";
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  /** One segment of a pen or eraser stroke on the drawing (a dot when it has no length). */
  private inkLine(from: { x: number; y: number }, to: { x: number; y: number }, tool: Tool): void {
    const ctx = this.ink.getContext("2d")!;
    ctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.radius(tool) * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    // A zero-length path draws nothing; nudge it so a single click leaves a dot.
    ctx.lineTo(to.x === from.x && to.y === from.y ? to.x + 0.01 : to.x, to.y);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  /** Paint from the last point of the stroke (or just at the point) with the given tool. */
  private paint(fx: number, fy: number, tool: Tool): void {
    const c = this.target(tool);
    const p = { x: fx * c.width, y: fy * c.height };
    const prev = this.last ? { x: this.last.x * c.width, y: this.last.y * c.height } : p;
    if (tool === "reveal" || tool === "hide") {
      // Fill the gap between pointer events so fast strokes stay continuous.
      const step = Math.max(1, this.radius(tool) / 3);
      const n = Math.max(1, Math.ceil(Math.hypot(p.x - prev.x, p.y - prev.y) / step));
      for (let i = this.last ? 1 : n; i <= n; i++) {
        this.fogDab(prev.x + ((p.x - prev.x) * i) / n, prev.y + ((p.y - prev.y) * i) / n, tool);
      }
      this.fogDirty = true;
    } else {
      this.inkLine(prev, p, tool);
      this.inkDirty = true;
    }
    this.last = { x: fx, y: fy };
    this.changed();
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || !this.itemId) return;
    this.stage.setPointerCapture(e.pointerId);
    this.drawing = true;
    this.last = null;
    const p = this.locate(e);
    this.paint(p.fx, p.fy, this.strokeTool(e));
    this.placeCursor(p.px, p.py);
  }

  private move(e: PointerEvent): void {
    const p = this.locate(e);
    this.placeCursor(p.px, p.py);
    if (this.drawing) this.paint(p.fx, p.fy, this.strokeTool(e));
  }

  private up(): void {
    this.drawing = false;
    this.last = null;
  }

  private placeCursor(px: number, py: number): void {
    this.cursor.hidden = false;
    this.cursor.style.left = `${px}px`;
    this.cursor.style.top = `${py}px`;
  }

  private fillFog(reveal: boolean): void {
    const ctx = this.mask.getContext("2d")!;
    ctx.clearRect(0, 0, this.mask.width, this.mask.height);
    if (reveal) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, this.mask.width, this.mask.height);
    }
    this.fogDirty = true;
    this.changed();
  }

  private clearInk(): void {
    this.ink.getContext("2d")!.clearRect(0, 0, this.ink.width, this.ink.height);
    this.inkDirty = true;
    this.changed();
  }

  private key(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey) return;
    const tools: Record<string, Tool> = { KeyR: "reveal", KeyH: "hide", KeyD: "draw", KeyE: "erase" };
    if (e.code === "BracketLeft" || e.code === "BracketRight") {
      e.preventDefault();
      const v = this.sizes[this.tool] + (e.code === "BracketLeft" ? -1 : 1);
      this.sizes[this.tool] = Math.min(Number(this.size.max), Math.max(Number(this.size.min), v));
      this.size.value = String(this.sizes[this.tool]);
      this.updateCursorSize();
    } else if (tools[e.code]) {
      e.preventDefault();
      this.setTool(tools[e.code]!);
    }
  }

  /** Redraw on the next frame. */
  private changed(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.redraw());
  }

  /** "Done" applies fog and drawing; anything else discards them. */
  private close(): void {
    const apply = this.applying;
    this.applying = false;
    this.drawing = false;
    this.last = null;
    if (!apply || !this.itemId || (!this.fogDirty && !this.inkDirty)) return;
    // Nothing hidden any more means no fog at all (no empty state is kept);
    // an empty drawing means no drawing.
    const fog = this.isFullyRevealed() ? null : this.mask.toDataURL("image/png");
    const ink = this.isInkEmpty() ? null : this.ink.toDataURL("image/png");
    this.onApply(this.itemId, fog, ink);
    this.fogDirty = false;
    this.inkDirty = false;
  }

  private isFullyRevealed(): boolean {
    if (!this.mask.width) return false;
    const data = this.mask.getContext("2d")!.getImageData(0, 0, this.mask.width, this.mask.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
    return true;
  }

  private isInkEmpty(): boolean {
    const data = this.ink.getContext("2d")!.getImageData(0, 0, this.ink.width, this.ink.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
    return true;
  }

  private redraw(): void {
    if (!this.img.naturalWidth) return;
    const box = this.stage.getBoundingClientRect();
    drawFog(this.fogView, box.width, box.height, this.img.naturalWidth, this.img.naturalHeight, this.mask);
    // The drawing view is a plain copy of the drawing over the image rectangle.
    const dpr = window.devicePixelRatio || 1;
    const v = this.inkView;
    v.width = Math.max(1, Math.round(box.width * dpr));
    v.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = v.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = containRect(box.width, box.height, this.img.naturalWidth, this.img.naturalHeight);
    ctx.drawImage(this.ink, r.x, r.y, r.w, r.h);
    this.updateCursorSize();
  }
}
