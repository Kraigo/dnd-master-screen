// DM control panel: pick an image, watch what the players see, blackout, zoom, sync.

import { connectSocket } from "../shared/socket.ts";
import type { Manifest, ManifestGroup, ManifestItem, PanelMessage, ScreenState, SyncStatus } from "../shared/types.ts";
import { clamp, computeView, MAX_ZOOM, MIN_ZOOM, pointToFocus, transformCss, type ViewTransform } from "../shared/view.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  preview: $("preview"),
  previewImg: $<HTMLImageElement>("preview-img"),
  previewFocus: $("preview-focus"),
  liveLabel: $("live-label"),
  zoom: $("zoom"),
  zoomRange: $<HTMLInputElement>("zoom-range"),
  zoomValue: $<HTMLOutputElement>("zoom-value"),
  zoomReset: $<HTMLButtonElement>("zoom-reset"),
  btnBlack: $<HTMLButtonElement>("btn-black"),
  btnRestore: $<HTMLButtonElement>("btn-restore"),
  screenDot: $("screen-dot"),
  screenStatus: $("screen-status"),
  openScreen: $<HTMLAnchorElement>("open-screen"),
  btnSync: $<HTMLButtonElement>("btn-sync"),
  syncStatus: $("sync-status"),
  syncBar: $("sync-bar"),
  syncErrors: $<HTMLDetailsElement>("sync-errors"),
  conn: $("conn"),
  tabs: $("tabs"),
  search: $<HTMLInputElement>("search"),
  grid: $("grid"),
  empty: $("empty"),
};

// ---------------------------------------------------------------------------
// State

let manifest: Manifest | null = null;
let mock = false;
let activeGroup = "";
let query = "";
let screen: ScreenState = { mode: "black", itemId: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
let sync: SyncStatus | null = null;
let itemsById = new Map<string, ManifestItem>();
let visible: ManifestItem[] = [];
let previewView: ViewTransform | null = null;

try {
  activeGroup = localStorage.getItem("mp.tab") ?? "";
} catch {
  // storage unavailable: fine
}

const socket = connectSocket(
  "panel",
  (msg) => onMessage(msg as PanelMessage),
  (connected) => {
    els.conn.hidden = connected;
  },
);

function send(cmd: unknown): void {
  socket.send(cmd);
}

// ---------------------------------------------------------------------------
// Manifest + library grid

async function loadManifest(): Promise<void> {
  const res = await fetch("/api/manifest", { cache: "no-store" });
  const data = (await res.json()) as { manifest: Manifest | null; mock: boolean; sync: SyncStatus };
  manifest = data.manifest;
  mock = data.mock;
  if (!sync || !sync.running) sync = data.sync;
  itemsById = new Map();
  for (const g of manifest?.groups ?? []) for (const it of g.items) if (!itemsById.has(it.id)) itemsById.set(it.id, it);
  if (!manifest?.groups.some((g) => g.id === activeGroup)) activeGroup = manifest?.groups[0]?.id ?? "";
  renderLibrary();
  renderLive();
  renderSync();
}

function matches(item: ManifestItem): boolean {
  return query === "" || item.label.toLowerCase().includes(query);
}

function renderTabs(groups: ManifestGroup[]): void {
  els.tabs.replaceChildren(
    ...groups.map((g) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(g.id === activeGroup));
      b.textContent = g.label;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(g.items.filter(matches).length);
      b.append(count);
      if (g.error) {
        const w = document.createElement("span");
        w.className = "warn";
        w.textContent = "error";
        w.title = g.error;
        b.append(w);
      }
      b.addEventListener("click", () => {
        activeGroup = g.id;
        try {
          localStorage.setItem("mp.tab", g.id);
        } catch {
          // ignore
        }
        renderLibrary();
      });
      return b;
    }),
  );
}

function itemButton(item: ManifestItem, index: number): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "item";
  b.dataset.id = item.id;
  const thumb = document.createElement("span");
  thumb.className = "thumb";
  if (item.file) {
    const img = document.createElement("img");
    img.src = `/images/${item.file}`;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    thumb.append(img);
    if (index < 9) {
      const n = document.createElement("span");
      n.className = "num";
      n.textContent = String(index + 1);
      thumb.append(n);
    }
    b.addEventListener("click", () => show(item.id));
  } else {
    b.disabled = true;
    thumb.textContent = item.failed ? "download failed" : "no image";
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = item.label;
  b.append(thumb, name);
  return b;
}

function renderLibrary(): void {
  const groups = manifest?.groups ?? [];
  const hasAny = groups.some((g) => g.items.length > 0);
  els.tabs.hidden = !manifest;
  els.search.hidden = !hasAny;

  if (!manifest || !hasAny) {
    els.grid.replaceChildren();
    visible = [];
    showEmpty(
      manifest ? "No images found" : "No images yet",
      manifest
        ? "Notion answered, but no page has a cover or an image. Add images and sync again."
        : "Download them from Notion before the game: after a sync the panel works offline.",
    );
    renderTabs(groups);
    return;
  }

  renderTabs(groups);
  const group = groups.find((g) => g.id === activeGroup) ?? groups[0]!;
  const list = group.items.filter(matches);
  // Items with an image first keep their numbers stable for the 1–9 shortcuts.
  visible = list.filter((i) => i.file);
  let n = 0;
  els.grid.replaceChildren(...list.map((it) => itemButton(it, it.file ? n++ : -1)));
  if (list.length === 0) {
    showEmpty(query ? "Nothing found" : "This section is empty", query ? "Try another word or clear the search." : "");
  } else {
    els.empty.hidden = true;
  }
  markOnScreen();
}

function showEmpty(title: string, text: string): void {
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  const parts: HTMLElement[] = [h, p];
  if (!manifest) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "act";
    b.textContent = "Sync";
    b.addEventListener("click", startSync);
    parts.push(b);
  }
  els.empty.replaceChildren(...parts);
  els.empty.hidden = false;
}

function markOnScreen(): void {
  for (const el of els.grid.querySelectorAll<HTMLElement>(".item")) {
    const on = el.dataset.id === screen.itemId;
    el.classList.toggle("on-screen", on);
    el.classList.toggle("dimmed", on && screen.mode === "black");
  }
}

// ---------------------------------------------------------------------------
// "Now on screen" preview

function updatePreviewTransform(): void {
  const img = els.previewImg;
  if (!img.naturalWidth) {
    previewView = null;
    return;
  }
  const box = els.preview.getBoundingClientRect();
  previewView = computeView(box.width, box.height, img.naturalWidth, img.naturalHeight, screen.zoom, screen.focusX, screen.focusY);
  img.style.transform = transformCss(previewView);
}

function renderLive(): void {
  const item = screen.itemId ? itemsById.get(screen.itemId) : undefined;
  const src = item?.file ? `/images/${item.file}` : null;
  const showing = screen.mode === "image" && src !== null;

  els.preview.dataset.mode = showing ? "image" : "black";
  els.preview.dataset.empty = String(!src);
  if (src && els.previewImg.getAttribute("src") !== src) {
    els.previewImg.style.transform = "";
    els.previewImg.src = src;
  } else if (!src) {
    els.previewImg.removeAttribute("src");
  }
  updatePreviewTransform();

  els.liveLabel.textContent = item ? item.label : "Nothing shown";
  els.liveLabel.classList.toggle("is-empty", !item);
  if (item && screen.mode === "black") els.liveLabel.textContent = `${item.label} (hidden)`;

  els.zoomRange.value = String(screen.zoom);
  els.zoomValue.value = `${formatZoom(screen.zoom)}×`;
  els.zoom.setAttribute("aria-disabled", String(!src));
  els.zoomRange.disabled = !src;
  els.zoomReset.disabled = !src;
  els.btnBlack.disabled = screen.mode === "black";
  els.btnRestore.disabled = !(screen.mode === "black" && src);
  markOnScreen();
}

function formatZoom(z: number): string {
  return Number.isInteger(z) ? String(z) : z.toFixed(2).replace(/0$/, "");
}

els.previewImg.addEventListener("load", updatePreviewTransform);
new ResizeObserver(updatePreviewTransform).observe(els.preview);

els.preview.addEventListener("click", (e) => {
  if (!previewView || !screen.itemId) return;
  const box = els.preview.getBoundingClientRect();
  const px = e.clientX - box.left;
  const py = e.clientY - box.top;
  const focus = pointToFocus(previewView, px, py);
  // At 1x a click alone would change nothing, so it also zooms in.
  const zoom = screen.zoom <= 1 ? 2 : screen.zoom;
  setView(zoom, focus.x, focus.y);
  els.previewFocus.style.left = `${px}px`;
  els.previewFocus.style.top = `${py}px`;
  els.previewFocus.hidden = false;
  els.previewFocus.style.animation = "none";
  void els.previewFocus.offsetWidth;
  els.previewFocus.style.animation = "";
});

let zoomFrame = 0;
els.zoomRange.addEventListener("input", () => {
  const z = Number(els.zoomRange.value);
  els.zoomValue.value = `${formatZoom(z)}×`;
  cancelAnimationFrame(zoomFrame);
  zoomFrame = requestAnimationFrame(() => setView(z, screen.focusX, screen.focusY));
});

els.zoomReset.addEventListener("click", () => setView(1, 0.5, 0.5));

function setView(zoom: number, focusX: number, focusY: number): void {
  screen = { ...screen, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), focusX, focusY };
  renderLive(); // optimistic; the server echoes the same state back
  send({ type: "view", zoom: screen.zoom, focusX, focusY });
}

// ---------------------------------------------------------------------------
// Commands

function show(itemId: string): void {
  send({ type: "show", itemId });
}

function blackout(): void {
  send({ type: "blackout" });
}

function restore(): void {
  send({ type: "restore" });
}

els.btnBlack.addEventListener("click", blackout);
els.btnRestore.addEventListener("click", restore);

els.openScreen.addEventListener("click", (e) => {
  e.preventDefault();
  window.open("/", "players-screen", "popup=yes,width=1280,height=760");
});

els.search.addEventListener("input", () => {
  query = els.search.value.trim().toLowerCase();
  renderLibrary();
});

function step(delta: number): void {
  if (visible.length === 0) return;
  const idx = visible.findIndex((i) => i.id === screen.itemId);
  const next = idx === -1 ? (delta > 0 ? 0 : visible.length - 1) : (idx + delta + visible.length) % visible.length;
  show(visible[next]!.id);
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target instanceof HTMLInputElement && e.target.type !== "range";

  // Esc always blacks out, even from the search box: it is the panic button.
  if (e.key === "Escape") {
    if (typing) (e.target as HTMLInputElement).blur();
    e.preventDefault();
    blackout();
    return;
  }
  if (typing) return;

  // e.code keeps shortcuts working with the Russian keyboard layout too.
  switch (e.code) {
    case "KeyB":
      e.preventDefault();
      blackout();
      return;
    case "KeyR":
      e.preventDefault();
      restore();
      return;
    case "ArrowRight":
      e.preventDefault();
      step(1);
      return;
    case "ArrowLeft":
      e.preventDefault();
      step(-1);
      return;
    case "Equal":
    case "NumpadAdd":
      if (screen.itemId) setView(screen.zoom + 0.5, screen.focusX, screen.focusY);
      return;
    case "Minus":
    case "NumpadSubtract":
      if (screen.itemId) setView(screen.zoom - 0.5, screen.focusX, screen.focusY);
      return;
    case "Digit0":
    case "Numpad0":
      if (screen.itemId) setView(1, 0.5, 0.5);
      return;
    case "Slash":
      e.preventDefault();
      els.search.focus();
      return;
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (digit) {
    const item = visible[Number(digit[1]) - 1];
    if (item) show(item.id);
  }
});

// ---------------------------------------------------------------------------
// Sync

async function startSync(): Promise<void> {
  els.btnSync.disabled = true;
  try {
    const res = await fetch("/api/sync", { method: "POST" });
    const data = (await res.json()) as { status: SyncStatus };
    sync = data.status;
  } catch {
    sync = null;
  }
  renderSync();
}

els.btnSync.addEventListener("click", startSync);

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function renderSync(): void {
  const s = sync;
  const running = !!s?.running;
  els.btnSync.disabled = running;
  els.btnSync.textContent = running ? "Syncing..." : "Sync";
  els.syncStatus.className = "sync-status";

  if (running && s) {
    els.syncStatus.textContent =
      s.phase === "downloading" && s.total > 0 ? `Downloading ${s.done} of ${s.total}` : (s.message ?? "Starting");
    els.syncBar.hidden = false;
    const pct = s.total > 0 ? (s.done / s.total) * 100 : 4;
    (els.syncBar.firstElementChild as HTMLElement).style.width = `${pct}%`;
  } else {
    els.syncBar.hidden = true;
    if (s?.phase === "error") {
      els.syncStatus.textContent = `Failed: ${s.message ?? "error"}`;
      els.syncStatus.classList.add("bad");
    } else if (manifest) {
      const when = dateFmt.format(new Date(manifest.syncedAt));
      const failed = s?.phase === "done" ? s.failures.length : 0;
      const tail = s?.phase !== "done" ? "" : s.downloaded > 0 ? `, new: ${s.downloaded}` : ", no changes";
      els.syncStatus.textContent = `Synced ${when}${tail}${mock ? " (demo images)" : ""}`;
      els.syncStatus.classList.add(failed ? "bad" : "ok");
    } else {
      els.syncStatus.textContent = "Not synced yet";
    }
  }

  const failures = s?.failures ?? [];
  els.syncErrors.hidden = failures.length === 0;
  if (failures.length) {
    els.syncErrors.querySelector("summary")!.textContent = `Failed downloads: ${failures.length}`;
    els.syncErrors.querySelector("ul")!.replaceChildren(
      ...failures.map((f) => {
        const li = document.createElement("li");
        li.textContent = `${f.label}: ${f.error}`;
        return li;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Server messages

function onMessage(msg: PanelMessage): void {
  switch (msg.type) {
    case "state": {
      screen = msg.state;
      els.preview.style.setProperty("--screen-aspect", String(msg.aspect));
      const n = msg.screens;
      els.screenDot.classList.toggle("on", n > 0);
      els.screenStatus.textContent =
        n === 0 ? "Players' screen not open" : n === 1 ? "Players' screen connected" : `Screens connected: ${n}`;
      renderLive();
      break;
    }
    case "sync":
      sync = msg.status;
      renderSync();
      break;
    case "manifest":
      void loadManifest();
      break;
  }
}

void loadManifest();
