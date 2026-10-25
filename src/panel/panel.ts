// DM control panel: pick an image, watch what the players see, blackout, zoom,
// switch projects, sync Notion.

import { connectSocket } from "../shared/socket.ts";
import type { AppState, Manifest, ManifestGroup, ManifestItem, PanelMessage, Project, ScreenState, SyncStatus } from "../shared/types.ts";
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
  projectSelect: $<HTMLSelectElement>("project-select"),
  btnProjects: $<HTMLButtonElement>("btn-projects"),
  sync: $("sync"),
  syncPath: $("sync-path"),
  btnSync: $<HTMLButtonElement>("btn-sync"),
  syncStatus: $("sync-status"),
  syncBar: $("sync-bar"),
  syncErrors: $<HTMLDetailsElement>("sync-errors"),
  conn: $("conn"),
  tabs: $("tabs"),
  search: $<HTMLInputElement>("search"),
  grid: $("grid"),
  empty: $("empty"),
  dialog: $<HTMLDialogElement>("projects"),
  dialogClose: $<HTMLButtonElement>("projects-close"),
  projectList: $("project-list"),
  addFolder: $<HTMLButtonElement>("add-folder"),
  addFolderType: $<HTMLButtonElement>("add-folder-type"),
  folderPathForm: $<HTMLFormElement>("folder-path-form"),
  folderPath: $<HTMLInputElement>("folder-path"),
  notionForm: $<HTMLFormElement>("notion-form"),
  notionLink: $<HTMLInputElement>("notion-link"),
  tokenSet: $("token-set"),
  tokenStatus: $("token-status"),
  tokenRemove: $<HTMLButtonElement>("token-remove"),
  tokenForm: $<HTMLFormElement>("token-form"),
  tokenInput: $<HTMLInputElement>("token-input"),
  dialogError: $("dialog-error"),
};

// ---------------------------------------------------------------------------
// State

let app: AppState | null = null;
let manifest: Manifest | null = null;
let activeGroup = "";
/** Set when the server refuses the panel (opened from another device). */
let remoteDenied = false;
let query = "";
let screen: ScreenState = { mode: "black", itemId: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
let sync: SyncStatus | null = null;
let itemsById = new Map<string, ManifestItem>();
let visible: ManifestItem[] = [];
let previewView: ViewTransform | null = null;

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

function activeProject(): Project | null {
  return app?.projects.find((p) => p.id === app?.activeProjectId) ?? null;
}

function tabKey(): string {
  return `mp.tab.${app?.activeProjectId ?? ""}`;
}

async function loadState(): Promise<void> {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (res.status === 403) {
    remoteDenied = true;
    renderLibrary();
    return;
  }
  const prevProject = app?.activeProjectId;
  app = (await res.json()) as AppState;
  manifest = app.manifest;
  if (!sync || !sync.running) sync = app.sync;
  itemsById = new Map();
  for (const g of manifest?.groups ?? []) for (const it of g.items) if (!itemsById.has(it.id)) itemsById.set(it.id, it);
  if (prevProject !== app.activeProjectId) {
    try {
      activeGroup = localStorage.getItem(tabKey()) ?? "";
    } catch {
      activeGroup = "";
    }
    query = "";
    els.search.value = "";
  }
  if (!manifest?.groups.some((g) => g.id === activeGroup)) activeGroup = manifest?.groups[0]?.id ?? "";
  renderProjects();
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
          localStorage.setItem(tabKey(), g.id);
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

interface EmptyAction {
  label: string;
  run: () => void;
}

/** Message shown instead of the grid when the active project has nothing to show. */
function emptyState(): { title: string; text: string; actions: EmptyAction[] } | null {
  const project = activeProject();
  if (remoteDenied) {
    return {
      title: "Panel is not available here",
      text: "Open the DM panel on the computer running the app. This device can show the players' screen only.",
      actions: [],
    };
  }
  if (!app) return { title: "Loading…", text: "", actions: [] };
  if (!project) {
    return {
      title: "Add your first project",
      text: "A project holds the images for one game. Pick a folder with images (subfolders become tabs), or connect a Notion campaign page.",
      actions: [
        { label: "Choose folder…", run: () => void addFolderProject() },
        { label: "Connect Notion…", run: openProjects },
      ],
    };
  }
  if (project.type === "folder") {
    if (app.folderError) {
      return { title: "Folder not available", text: app.folderError, actions: [{ label: "Try again", run: startSync }] };
    }
    if (!manifest?.groups.length) {
      return {
        title: "No images in this folder yet",
        text: `Put jpg, png, webp or gif files into ${project.path}. Subfolders become tabs. The list updates by itself.`,
        actions: [],
      };
    }
    return null;
  }
  if (!manifest) {
    return app.notion.tokenSet
      ? {
          title: "No images yet",
          text: "Download them from Notion before the game: after a sync the panel works offline.",
          actions: [{ label: "Sync", run: startSync }],
        }
      : {
          title: "Notion token needed",
          text: "Add the integration token in Projects, then sync.",
          actions: [{ label: "Open Projects", run: openProjects }],
        };
  }
  if (!manifest.groups.some((g) => g.items.length > 0)) {
    return {
      title: "No images found",
      text: "Notion answered, but there is no database or image on the campaign page. Add images and sync again.",
      actions: [{ label: "Sync", run: startSync }],
    };
  }
  return null;
}

function renderLibrary(): void {
  const groups = manifest?.groups ?? [];
  const empty = emptyState();
  els.tabs.hidden = !!empty;
  els.search.hidden = !!empty;

  if (empty) {
    els.grid.replaceChildren();
    visible = [];
    showEmpty(empty.title, empty.text, empty.actions);
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

function showEmpty(title: string, text: string, actions: EmptyAction[] = []): void {
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  const row = document.createElement("div");
  row.className = "row";
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "act";
    b.textContent = a.label;
    b.addEventListener("click", a.run);
    row.append(b);
  }
  els.empty.replaceChildren(h, p, row);
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
  // While the Projects dialog is open, keys belong to it (Esc closes it).
  if (els.dialog.open) return;
  const typing =
    (e.target instanceof HTMLInputElement && e.target.type !== "range") || e.target instanceof HTMLSelectElement;

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

/** Notion: download from Notion. Folder: rescan right away. */
async function startSync(): Promise<void> {
  const project = activeProject();
  if (!project) return;
  els.btnSync.disabled = true;
  const res = await api("POST", `/api/projects/${project.id}/sync`);
  if (!res.ok && project.type === "notion") {
    sync = { ...(sync ?? app!.sync), projectId: project.id, running: false, phase: "error", message: res.error };
  }
  renderSync();
}

els.btnSync.addEventListener("click", startSync);

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function renderSync(): void {
  const project = activeProject();
  els.sync.hidden = !project;
  if (!project) return;
  els.syncStatus.className = "sync-status";
  els.syncPath.hidden = project.type !== "folder";

  if (project.type === "folder") {
    els.btnSync.disabled = false;
    els.btnSync.textContent = "Rescan";
    els.syncBar.hidden = true;
    els.syncErrors.hidden = true;
    els.syncPath.textContent = project.path;
    els.syncPath.title = project.path;
    if (app?.folderError) {
      els.syncStatus.textContent = app.folderError;
      els.syncStatus.classList.add("bad");
    } else {
      const n = manifest?.groups.reduce((sum, g) => sum + g.items.length, 0) ?? 0;
      els.syncStatus.textContent = `${n} ${n === 1 ? "image" : "images"}, updates by itself`;
      els.syncStatus.classList.add("ok");
    }
    return;
  }

  // Progress of a sync that belongs to another project is not shown here.
  const s = sync?.projectId === project.id ? sync : null;
  const running = !!sync?.running;
  els.btnSync.disabled = running || !app?.notion.tokenSet;
  els.btnSync.textContent = s?.running ? "Syncing..." : "Sync";

  if (s?.running) {
    els.syncStatus.textContent =
      s.phase === "downloading" && s.total > 0 ? `Downloading ${s.done} of ${s.total}` : (s.message ?? "Starting");
    els.syncBar.hidden = false;
    const pct = s.total > 0 ? (s.done / s.total) * 100 : 4;
    (els.syncBar.firstElementChild as HTMLElement).style.width = `${pct}%`;
  } else {
    els.syncBar.hidden = true;
    if (!app?.notion.tokenSet) {
      els.syncStatus.textContent = "Add the Notion token in Projects";
      els.syncStatus.classList.add("bad");
    } else if (running) {
      els.syncStatus.textContent = "Another project is syncing";
    } else if (s?.phase === "error") {
      els.syncStatus.textContent = `Failed: ${s.message ?? "error"}`;
      els.syncStatus.classList.add("bad");
    } else if (manifest) {
      const when = dateFmt.format(new Date(manifest.syncedAt));
      const failed = s?.phase === "done" ? s.failures.length : 0;
      const tail = s?.phase !== "done" ? "" : s.downloaded > 0 ? `, new: ${s.downloaded}` : ", no changes";
      els.syncStatus.textContent = `Synced ${when}${tail}`;
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
// Projects

async function api(method: string, url: string, data?: unknown): Promise<{ ok: boolean; error: string; data: any }> {
  try {
    const res = await fetch(url, {
      method,
      headers: data === undefined ? {} : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, error: body?.error ?? (res.ok ? "" : `HTTP ${res.status}`), data: body };
  } catch {
    return { ok: false, error: "No connection to the app", data: null };
  }
}

function showDialogError(msg: string): void {
  els.dialogError.textContent = msg;
  els.dialogError.hidden = !msg;
}

function projectWhere(p: Project): string {
  return p.type === "folder" ? `Folder · ${p.path}` : "Notion page";
}

function renderProjects(): void {
  const list = app?.projects ?? [];
  const activeId = app?.activeProjectId ?? null;

  els.projectSelect.replaceChildren(
    ...list.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      o.selected = p.id === activeId;
      return o;
    }),
  );
  els.projectSelect.hidden = list.length === 0;

  els.projectList.replaceChildren(
    ...list.map((p) => {
      const li = document.createElement("li");
      li.className = "project";
      li.classList.toggle("is-active", p.id === activeId);

      const info = document.createElement("div");
      info.className = "project-info";
      const name = document.createElement("span");
      name.className = "project-name";
      name.textContent = p.name;
      const where = document.createElement("span");
      where.className = "project-where";
      where.textContent = projectWhere(p);
      where.title = projectWhere(p);
      info.append(name, where);

      const actions = document.createElement("div");
      actions.className = "project-actions";
      const mk = (label: string, run: () => void, disabled = false) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "quiet";
        b.textContent = label;
        b.disabled = disabled;
        b.addEventListener("click", run);
        actions.append(b);
      };
      mk("Open", () => void activateProject(p.id, true), p.id === activeId);
      mk("Rename", () => void renameProject(p));
      mk("Remove", () => void removeProject(p));

      li.append(info, actions);
      return li;
    }),
  );
  els.projectList.hidden = list.length === 0;

  const notion = app?.notion;
  els.tokenSet.hidden = !notion?.tokenSet;
  els.tokenForm.hidden = !!notion?.tokenSet;
  els.tokenStatus.textContent = notion?.tokenSet ? `Connected to the "${notion.workspace ?? "Notion"}" workspace.` : "";
}

async function activateProject(id: string, close = false): Promise<void> {
  if (id !== app?.activeProjectId) {
    const res = await api("POST", `/api/projects/${id}/activate`);
    if (!res.ok) return showDialogError(res.error);
  }
  if (close) els.dialog.close();
}

async function renameProject(p: Project): Promise<void> {
  const name = prompt("Project name", p.name)?.trim();
  if (!name || name === p.name) return;
  const res = await api("PATCH", `/api/projects/${p.id}`, { name });
  showDialogError(res.ok ? "" : res.error);
}

async function removeProject(p: Project): Promise<void> {
  const note =
    p.type === "folder"
      ? "The folder and its images stay where they are."
      : "Downloaded images are removed from the app; nothing changes in Notion.";
  if (!confirm(`Remove the project "${p.name}"?\n${note}`)) return;
  const res = await api("DELETE", `/api/projects/${p.id}`);
  showDialogError(res.ok ? "" : res.error);
}

async function createProject(data: Record<string, string>): Promise<boolean> {
  const res = await api("POST", "/api/projects", data);
  showDialogError(res.ok ? "" : res.error);
  return res.ok;
}

async function addFolderProject(): Promise<void> {
  showDialogError("");
  const res = await api("POST", "/api/pick-folder");
  if (!res.ok) {
    // No native dialog on this system: fall back to typing the path.
    openProjects();
    els.folderPathForm.hidden = false;
    els.folderPath.focus();
    showDialogError(res.error);
    return;
  }
  const path = res.data?.path as string | null;
  if (path && (await createProject({ type: "folder", path }))) els.dialog.close();
}

function openProjects(): void {
  showDialogError("");
  if (!els.dialog.open) els.dialog.showModal();
}

els.btnProjects.addEventListener("click", openProjects);
els.dialogClose.addEventListener("click", () => els.dialog.close());
els.dialog.addEventListener("click", (e) => {
  if (e.target === els.dialog) els.dialog.close(); // click on the backdrop
});
els.projectSelect.addEventListener("change", () => void activateProject(els.projectSelect.value));
els.addFolder.addEventListener("click", () => void addFolderProject());
els.addFolderType.addEventListener("click", () => {
  els.folderPathForm.hidden = false;
  els.folderPath.focus();
});

els.folderPathForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const path = els.folderPath.value.trim();
  if (!path) return;
  if (await createProject({ type: "folder", path })) {
    els.folderPath.value = "";
    els.folderPathForm.hidden = true;
    els.dialog.close();
  }
});

els.notionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const link = els.notionLink.value.trim();
  if (!link) return;
  if (await createProject({ type: "notion", link })) {
    els.notionLink.value = "";
    els.dialog.close();
  }
});

els.tokenForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = els.tokenInput.value.trim();
  if (!token) return;
  const button = els.tokenForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true;
  button.textContent = "Checking…";
  const res = await api("PUT", "/api/notion-token", { token });
  button.disabled = false;
  button.textContent = "Save token";
  if (res.ok) els.tokenInput.value = "";
  showDialogError(res.ok ? "" : res.error);
});

els.tokenRemove.addEventListener("click", async () => {
  if (!confirm("Remove the Notion token? Downloaded images stay, but you cannot sync until you add it again.")) return;
  const res = await api("DELETE", "/api/notion-token");
  showDialogError(res.ok ? "" : res.error);
});

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
      void loadState();
      break;
  }
}

void loadState();
