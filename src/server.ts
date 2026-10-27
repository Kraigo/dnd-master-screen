// dnd-master-screen server: DM control panel, players' screen, project images and live state.
// Showing images never talks to Notion: Notion projects are served from their cache,
// folder projects straight from the folder. Notion is contacted only on "Sync".
//
// By default the server listens on 127.0.0.1 only. With "other devices" turned on
// (LAN mode) it listens on all interfaces: other devices may open the players'
// screen ("/") freely, and the master panel ("/master") after entering the master
// password. Turning LAN mode on/off and quitting the app stay local-only.

import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { readManifest } from "./manifest.ts";
import { pickFolder } from "./os/pick-folder.ts";
import { folderName, scanFolder, watchFolder } from "./projects/folder.ts";
import { isObsidianFolder, scanObsidian } from "./projects/obsidian.ts";
import {
  isLocalProject,
  type AppState,
  type Manifest,
  type PanelCommand,
  type PanelMessage,
  type Project,
  type ScreenHello,
  type ScreenMessage,
  type FogMask,
  type Ink,
  type ScreenState,
  type ScreenView,
  type SyncStatus,
} from "./shared/types.ts";
import { clamp, MAX_ZOOM, MIN_ZOOM } from "./shared/view.ts";
import {
  clearData,
  ensureDataDir,
  newProjectId,
  projectDir,
  readImageMap,
  readRecent,
  readProjects,
  readSettings,
  removeProjectCache,
  updateSettings,
  writeImageMap,
  writeRecent,
  type RecentEntry,
  writeProjects,
  type Settings,
} from "./store.ts";
import { CACHE_FILE_RE } from "./sync/download.ts";
import { idleStatus, runSync } from "./sync/index.ts";
import { describeNotionError, NotionSource, parseNotionPageId } from "./sync/notion.ts";
import panelPage from "./panel/index.html";
import screenPage from "./screen/index.html";

export const APP_ID = "dnd-master-screen";

/** Running as the standalone executable (code lives in Bun's embedded file system). */
const COMPILED = /\$bunfs|~BUN/.test(import.meta.url);

type WsData = { role: "panel" | "screen" };
type Ws = ServerWebSocket<WsData>;

// ---------------------------------------------------------------------------
// Projects and the active library

let projects: Project[] = [];
let settings: Settings = {
  activeProjectId: null,
  notionToken: null,
  notionWorkspace: null,
  lanEnabled: false,
  masterPasswordHash: null,
};
let active: Project | null = null;
let manifest: Manifest | null = null;
let folderError: string | null = null;
/** Folder projects: served name -> absolute path. Only these names are ever served. */
let folderFiles = new Map<string, string>();
let fileById = new Map<string, string>();
let stopWatching: (() => void) | null = null;

const BLACK: ScreenState = { mode: "black", itemId: null, zoom: 1, focusX: 0.5, focusY: 0.5, fog: false };
let state: ScreenState = BLACK;
/** Fog of war of the active project's images (item id -> mask), persisted in fog.json. */
let fog = new Map<string, string>();
/** Drawings on the active project's images (item id -> transparent PNG), persisted in ink.json. */
let ink = new Map<string, string>();
/** Recently shown images with their view, newest first (the recents palette), persisted in recent.json. */
let recent: RecentEntry[] = [];
const RECENT_MAX = 9;
let stateSaveTimer: ReturnType<typeof setTimeout> | undefined;
let screenAspect = 16 / 9;
let syncStatus: SyncStatus = idleStatus();
let server: Server<WsData> | null = null;

/** (Re)load the image list of the active project. Returns true if it changed. */
async function loadLibrary(): Promise<boolean> {
  const before = JSON.stringify([manifest?.groups ?? null, folderError]);
  folderFiles = new Map();
  folderError = null;
  if (!active) {
    manifest = null;
  } else if (isLocalProject(active)) {
    try {
      const scan = active.type === "obsidian" ? await scanObsidian(active.path) : await scanFolder(active.path);
      manifest = scan.manifest;
      folderFiles = scan.files;
    } catch (e) {
      manifest = null;
      folderError = e instanceof Error ? e.message : String(e);
    }
  } else {
    manifest = await readManifest(projectDir(active.id));
  }
  fileById = new Map();
  for (const g of manifest?.groups ?? []) {
    for (const it of g.items) if (it.file && !fileById.has(it.id)) fileById.set(it.id, it.file);
  }
  return JSON.stringify([manifest?.groups ?? null, folderError]) !== before;
}

async function activate(project: Project | null): Promise<void> {
  stopWatching?.();
  stopWatching = null;
  active = project;
  await flushProjectState();
  state = BLACK;
  fog = project ? await readImageMap(project.id, "fog.json") : new Map();
  ink = project ? await readImageMap(project.id, "ink.json") : new Map();
  recent = project ? await readRecent(project.id) : [];
  if (settings.activeProjectId !== (project?.id ?? null)) {
    settings = await updateSettings({ activeProjectId: project?.id ?? null });
  }
  await loadLibrary();
  if (isLocalProject(project)) {
    const id = project.id;
    stopWatching = watchFolder(project.path, () => {
      if (active?.id !== id) return;
      void loadLibrary().then((changed) => {
        if (!changed) return;
        publishPanel({ type: "manifest" });
        publishState(); // the image on screen may have been deleted
      });
    });
  }
  publishPanel({ type: "manifest" });
  publishState();
}

function lanAddresses(): string[] {
  if (!settings.lanEnabled || !server) return [];
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${server.port}`);
    }
  }
  return out;
}

function appState(req: Request): AppState {
  return {
    projects,
    activeProjectId: active?.id ?? null,
    manifest,
    folderError,
    sync: syncStatus,
    fogged: [...fog.keys()],
    inked: [...ink.keys()],
    recent: recent.map((r) => r.itemId),
    notion: { tokenSet: !!settings.notionToken, workspace: settings.notionWorkspace },
    lan: { enabled: settings.lanEnabled, addresses: lanAddresses() },
    local: isLocal(req),
  };
}

// ---------------------------------------------------------------------------
// Screen state

/** Fog of what is on screen now (see FogMask). */
function currentFog(): FogMask {
  if (!state.fog || !state.itemId) return null;
  return fog.get(state.itemId) ?? "";
}

/** Drawing on what is on screen now. */
function currentInk(): Ink {
  return state.itemId ? (ink.get(state.itemId) ?? null) : null;
}

function screenView(): ScreenView {
  const file = state.itemId ? fileById.get(state.itemId) : undefined;
  return {
    mode: file ? state.mode : "black",
    src: file ? `/images/${file}` : null,
    zoom: state.zoom,
    focusX: state.focusX,
    focusY: state.focusY,
    fog: currentFog(),
    ink: currentInk(),
  };
}

function panelStateMessage(): PanelMessage {
  return { type: "state", state, screens: server?.subscriberCount("screen") ?? 0, aspect: screenAspect, fog: currentFog(), ink: currentInk() };
}

function publishMarks(): void {
  publishPanel({ type: "marks", fogged: [...fog.keys()], inked: [...ink.keys()] });
}

/**
 * Record what is on screen in the recents palette, with its current view. A newly
 * shown image goes first; an image already in the palette keeps its place unless
 * `toFront` (so picking one from the palette, zooming or toggling fog never reorders).
 */
function touchRecent(toFront: boolean): void {
  if (!state.itemId || !fileById.has(state.itemId)) return;
  const entry: RecentEntry = { itemId: state.itemId, zoom: state.zoom, focusX: state.focusX, focusY: state.focusY };
  const order = recent.map((r) => r.itemId).join();
  const at = recent.findIndex((r) => r.itemId === entry.itemId);
  if (at >= 0 && !toFront) recent[at] = entry;
  else recent = [entry, ...recent.filter((r) => r.itemId !== entry.itemId)].slice(0, RECENT_MAX);
  saveStateSoon();
  // The panel only shows the order; zoom changes alone need no message.
  if (recent.map((r) => r.itemId).join() !== order) publishPanel({ type: "recent", ids: recent.map((r) => r.itemId) });
}

/** Save fog and recents a moment after the last change (zoom and palette changes come in bursts). */
function saveStateSoon(): void {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => void flushProjectState(), 1000);
}

async function flushProjectState(): Promise<void> {
  if (stateSaveTimer === undefined) return;
  clearTimeout(stateSaveTimer);
  stateSaveTimer = undefined;
  if (!active) return;
  await Promise.all([
    writeImageMap(active.id, "fog.json", fog),
    writeImageMap(active.id, "ink.json", ink),
    writeRecent(active.id, recent),
  ]).catch((e) => console.error(`Could not save fog, drawings and recent images: ${(e as Error).message}`));
}

const isPng = (v: string) => v.startsWith("data:image/png;base64,") && v.length < 8_000_000;

/** Fog from the editor: null (none), "" (fully covered) or a PNG data URL of sane size. */
function validFog(mask: unknown): mask is FogMask {
  return mask === null || (typeof mask === "string" && (mask === "" || isPng(mask)));
}

/** Drawing from the editor: null (none) or a PNG data URL of sane size. */
function validInk(v: unknown): v is Ink {
  return v === null || (typeof v === "string" && isPng(v));
}

function publishPanel(msg: PanelMessage): void {
  server?.publish("panel", JSON.stringify(msg));
}

function publishState(): void {
  const view: ScreenMessage = { type: "view", view: screenView() };
  server?.publish("screen", JSON.stringify(view));
  publishPanel(panelStateMessage());
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function handlePanelCommand(cmd: PanelCommand): void {
  const before = state.itemId;
  switch (cmd.type) {
    case "show": {
      if (typeof cmd.itemId !== "string" || !fileById.has(cmd.itemId)) return;
      // An image that was fogged before comes back with its fog.
      state = { mode: "image", itemId: cmd.itemId, zoom: 1, focusX: 0.5, focusY: 0.5, fog: fog.has(cmd.itemId) };
      break;
    }
    case "show-fogged": {
      if (typeof cmd.itemId !== "string" || !fileById.has(cmd.itemId)) return;
      if (!fog.has(cmd.itemId)) {
        fog.set(cmd.itemId, "");
        saveStateSoon();
        publishMarks();
      }
      const same = state.itemId === cmd.itemId;
      state = same
        ? { ...state, mode: "image", fog: true }
        : { mode: "image", itemId: cmd.itemId, zoom: 1, focusX: 0.5, focusY: 0.5, fog: true };
      break;
    }
    case "unfog": {
      if (typeof cmd.itemId !== "string" || !fileById.has(cmd.itemId)) return;
      if (fog.delete(cmd.itemId)) {
        saveStateSoon();
        publishMarks();
      }
      const same = state.itemId === cmd.itemId;
      state = same
        ? { ...state, mode: "image", fog: false }
        : { mode: "image", itemId: cmd.itemId, zoom: 1, focusX: 0.5, focusY: 0.5, fog: false };
      break;
    }
    case "apply-edits": {
      if (typeof cmd.itemId !== "string" || !fileById.has(cmd.itemId) || !validFog(cmd.fog) || !validInk(cmd.ink)) return;
      if (cmd.fog === null) fog.delete(cmd.itemId);
      else fog.set(cmd.itemId, cmd.fog);
      if (cmd.ink === null) ink.delete(cmd.itemId);
      else ink.set(cmd.itemId, cmd.ink);
      saveStateSoon();
      publishMarks();
      // Only the screen cares, and only if this image is on it.
      if (state.itemId !== cmd.itemId) return;
      state = { ...state, fog: cmd.fog !== null };
      break;
    }
    case "blackout":
      state = { ...state, mode: "black" };
      break;
    case "restore":
      if (!state.itemId) return;
      state = { ...state, mode: "image" };
      break;
    case "view":
      state = {
        ...state,
        zoom: clamp(num(cmd.zoom, 1), MIN_ZOOM, MAX_ZOOM),
        focusX: clamp(num(cmd.focusX, 0.5), 0, 1),
        focusY: clamp(num(cmd.focusY, 0.5), 0, 1),
      };
      break;
    case "show-recent": {
      const entry = recent.find((r) => r.itemId === cmd.itemId);
      if (!entry || !fileById.has(entry.itemId)) return;
      state = {
        mode: "image",
        itemId: entry.itemId,
        zoom: clamp(entry.zoom, MIN_ZOOM, MAX_ZOOM),
        focusX: clamp(entry.focusX, 0, 1),
        focusY: clamp(entry.focusY, 0, 1),
        fog: fog.has(entry.itemId),
      };
      break;
    }
    default:
      return;
  }
  if (cmd.type !== "blackout" && cmd.type !== "restore") {
    // Only a different image shown from the library moves to the front of the palette.
    const fromLibrary = cmd.type === "show" || cmd.type === "show-fogged" || cmd.type === "unfog";
    touchRecent(fromLibrary && state.itemId !== before);
  }
  publishState();
}

// ---------------------------------------------------------------------------
// Notion sync

function startSync(project: Project & { type: "notion" }): string | null {
  if (syncStatus.running) return "A sync is already running";
  if (!settings.notionToken) return "Add the Notion token first";
  syncStatus = { ...idleStatus(), projectId: project.id, running: true, phase: "listing", startedAt: new Date().toISOString() };
  publishPanel({ type: "sync", status: syncStatus });
  void runSync({
    projectId: project.id,
    token: settings.notionToken,
    rootPageId: project.rootPageId,
    dir: projectDir(project.id),
    onProgress: (s) => {
      syncStatus = s;
      publishPanel({ type: "sync", status: s });
    },
  }).then(async () => {
    if (active?.id !== project.id) return;
    await loadLibrary();
    publishPanel({ type: "manifest" });
    publishState();
  });
  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers

/** Reject cross-site requests (a random web page POSTing to localhost). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

function isLocal(req: Request): boolean {
  const ip = server?.requestIP(req)?.address ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

type Req = Request & { params: Record<string, string> };

// ---------------------------------------------------------------------------
// Master password (other devices only; the computer running the app never needs it)

const SESSION_COOKIE = "dms_session";
/** Session tokens of devices that entered the password. Kept in memory: a restart logs them out. */
let sessions = new Set<string>();
const failedLogins = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

function sessionOf(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`).exec(cookie);
  return m?.[1] ?? null;
}

function authorized(req: Request): boolean {
  if (isLocal(req)) return true;
  const token = sessionOf(req);
  return settings.lanEnabled && token !== null && sessions.has(token);
}

function newSessionCookie(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  sessions.add(token);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
}

const MIN_PASSWORD = 4;

/** Panel endpoints: this computer, or another device with the master password. Same-origin for changes. */
function guarded(handler: (req: Req) => Response | Promise<Response>) {
  return (req: Req) => {
    if (!authorized(req)) return json({ error: "Enter the master password", needsPassword: true }, 401);
    if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "forbidden" }, 403);
    return handler(req);
  };
}

/** Endpoints that only the computer running the app may call. */
function localOnly(handler: (req: Req) => Response | Promise<Response>) {
  return (req: Req) => {
    if (!isLocal(req)) return json({ error: "Only available on the computer running the app" }, 403);
    if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "forbidden" }, 403);
    return handler(req);
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const data = await req.json().catch(() => null);
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function findProject(id: string | null | undefined): Project | undefined {
  return projects.find((p) => p.id === id);
}

async function saveProjects(): Promise<void> {
  await writeProjects(projects);
  publishPanel({ type: "manifest" });
}

async function createProject(input: Record<string, unknown>): Promise<Project | string> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (input.type === "folder") {
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path) return "Choose a folder";
    const s = await stat(path).catch(() => null);
    if (!s?.isDirectory()) return `Folder not found: ${path}`;
    // A folder in an Obsidian vault: group images by the notes that embed them.
    const type = (await isObsidianFolder(path)) ? "obsidian" : "folder";
    return { id: newProjectId(), name: name || folderName(path), type, path };
  }
  if (input.type === "notion") {
    const rootPageId = parseNotionPageId(typeof input.link === "string" ? input.link : "");
    if (!rootPageId) return "Paste a link to a Notion page";
    let title = "";
    if (!name && settings.notionToken) {
      title = await new NotionSource(settings.notionToken).titleOf(rootPageId).catch(() => "");
    }
    return { id: newProjectId(), name: name || title || "Notion campaign", type: "notion", rootPageId };
  }
  return "Unknown project type";
}

// ---------------------------------------------------------------------------
// Actions shared by the HTTP API and the console (src/console.ts)

/** Turn access from other devices on/off and/or set a new master password. Call rebind() afterwards. */
export async function setOtherDevices(enabled: boolean, password = ""): Promise<string | null> {
  if (password && password.length < MIN_PASSWORD) return `The password needs at least ${MIN_PASSWORD} characters`;
  if (enabled && !password && !settings.masterPasswordHash) return "Set a password first";
  const patch: Partial<Settings> = { lanEnabled: enabled };
  if (password) {
    patch.masterPasswordHash = await Bun.password.hash(password);
    sessions = new Set(); // a new password logs every other device out
  }
  if (!enabled) sessions = new Set();
  settings = await updateSettings(patch);
  publishPanel({ type: "manifest" });
  return null;
}

export function otherDevicesState(): { enabled: boolean; passwordSet: boolean } {
  return { enabled: settings.lanEnabled, passwordSet: !!settings.masterPasswordHash };
}

/** Create a project, make it active and, for Notion, start the first sync. */
export async function addProject(input: Record<string, unknown>): Promise<Project | string> {
  const created = await createProject(input);
  if (typeof created === "string") return created;
  projects = [...projects, created];
  await saveProjects();
  await activate(created);
  if (created.type === "notion" && settings.notionToken) startSync(created);
  return created;
}

export function projectList(): { projects: Project[]; activeId: string | null } {
  return { projects, activeId: active?.id ?? null };
}

export async function openProject(id: string): Promise<boolean> {
  const p = findProject(id);
  if (!p) return false;
  await activate(p);
  return true;
}

/** Forget every project, the Notion token and the master password. Linked folders are not touched. */
export async function clearAllData(): Promise<string | null> {
  if (syncStatus.running) return "Wait for the sync to finish";
  await activate(null);
  await clearData();
  projects = [];
  settings = await readSettings();
  sessions = new Set();
  syncStatus = idleStatus();
  await rebind();
  publishPanel({ type: "manifest" });
  return null;
}

export function quitApp(reason: string): void {
  console.log(`\n${reason}`);
  // Save pending fog edits first; exit even if that fails.
  void flushProjectState().finally(() => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Server

function listenHost(): string {
  return settings.lanEnabled ? "0.0.0.0" : "127.0.0.1";
}

export function logLan(): void {
  const addresses = lanAddresses();
  if (!addresses.length) return;
  console.log("\nOn other devices in this network:");
  for (const a of addresses) {
    console.log(`  Players' screen: ${a}/`);
    console.log(`  Master panel:    ${a}/master  (asks for the master password)`);
  }
}

/** Restart the listener after LAN mode changed (Bun cannot change the address of a running server). */
export async function rebind(): Promise<void> {
  if (!server || server.hostname === listenHost()) return;
  const port = server.port ?? 0;
  server.stop(true);
  try {
    server = createServer(listenHost(), port);
  } catch (e) {
    console.error(`Could not listen on ${listenHost()}:${port}: ${(e as Error).message}`);
    settings = await updateSettings({ lanEnabled: false });
    server = createServer(listenHost(), port);
  }
  if (!settings.lanEnabled) console.log("\nOnly this computer can open the app now.");
  logLan();
}

export async function startServer(port: number): Promise<Server<WsData>> {
  await ensureDataDir();
  projects = await readProjects();
  settings = await readSettings();
  // Closing the console window or stopping the process: save pending fog edits first.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => quitApp("Stopped."));
  server = createServer(listenHost(), port);
  await activate(findProject(settings.activeProjectId) ?? projects[0] ?? null);
  return server;
}

function createServer(hostname: string, port: number): Server<WsData> {
  return Bun.serve({
    hostname,
    port,
    development: process.env.NODE_ENV !== "production" && !COMPILED,
    routes: {
      "/": screenPage,
      "/master": panelPage,

      "/api/health": () => json({ app: APP_ID }),

      "/api/state": { GET: guarded((req) => json(appState(req))) },

      "/api/login": {
        POST: async (req) => {
          if (!settings.lanEnabled || !settings.masterPasswordHash) return json({ error: "Not available" }, 404);
          if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
          const ip = server?.requestIP(req)?.address ?? "?";
          const now = Date.now();
          const fails = failedLogins.get(ip);
          if (fails && fails.until > now) return json({ error: "Too many attempts, wait a minute" }, 429);
          const password = (await body(req)).password;
          const ok = typeof password === "string" && (await Bun.password.verify(password, settings.masterPasswordHash));
          if (!ok) {
            const count = (fails && fails.until > 0 && fails.until <= now ? 0 : (fails?.count ?? 0)) + 1;
            failedLogins.set(ip, { count, until: count >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0 });
            return json({ error: "Wrong password" }, 401);
          }
          failedLogins.delete(ip);
          return Response.json({ ok: true }, { headers: { "Set-Cookie": newSessionCookie(), "Cache-Control": "no-store" } });
        },
      },

      // Turn access from other devices on/off, set or change the master password.
      "/api/lan": {
        PUT: localOnly(async (req) => {
          const input = await body(req);
          const password = typeof input.password === "string" ? input.password : "";
          const error = await setOtherDevices(input.enabled === true, password);
          if (error) return json({ error }, 400);
          // Answer first: rebinding closes every open connection, this one included.
          setTimeout(() => void rebind(), 100);
          return json({ ok: true });
        }),
      },

      "/api/quit": {
        POST: localOnly(() => {
          setTimeout(() => quitApp("Stopped from the master panel."), 200);
          return json({ ok: true });
        }),
      },

      "/api/projects": {
        POST: guarded(async (req) => {
          const created = await addProject(await body(req));
          if (typeof created === "string") return json({ error: created }, 400);
          return json({ project: created }, 201);
        }),
      },

      "/api/projects/:id": {
        PATCH: guarded(async (req) => {
          const p = findProject(req.params.id);
          if (!p) return json({ error: "Project not found" }, 404);
          const name = (await body(req)).name;
          if (typeof name !== "string" || !name.trim()) return json({ error: "Name cannot be empty" }, 400);
          projects = projects.map((x) => (x.id === p.id ? { ...x, name: name.trim() } : x));
          if (active?.id === p.id) active = findProject(p.id)!;
          await saveProjects();
          return json({ ok: true });
        }),
        DELETE: guarded(async (req) => {
          const p = findProject(req.params.id);
          if (!p) return json({ error: "Project not found" }, 404);
          if (syncStatus.running && syncStatus.projectId === p.id) return json({ error: "Wait for the sync to finish" }, 409);
          projects = projects.filter((x) => x.id !== p.id);
          await saveProjects();
          // Pending fog edits of a removed project must not recreate its folder.
          if (active?.id === p.id) {
            clearTimeout(stateSaveTimer);
            stateSaveTimer = undefined;
          }
          // Only our own cache is removed; a linked folder is never touched.
          await removeProjectCache(p.id);
          if (active?.id === p.id) await activate(projects[0] ?? null);
          return json({ ok: true });
        }),
      },

      "/api/projects/:id/activate": {
        POST: guarded(async (req) => {
          if (!(await openProject(req.params.id ?? ""))) return json({ error: "Project not found" }, 404);
          return json({ ok: true });
        }),
      },

      // Notion: download from Notion. Folder: rescan (normally the folder is watched).
      "/api/projects/:id/sync": {
        POST: guarded(async (req) => {
          const p = findProject(req.params.id);
          if (!p) return json({ error: "Project not found" }, 404);
          if (isLocalProject(p)) {
            if (active?.id === p.id && (await loadLibrary())) {
              publishPanel({ type: "manifest" });
              publishState();
            }
            return json({ ok: true });
          }
          const error = startSync(p);
          return error ? json({ error }, 409) : json({ ok: true }, 202);
        }),
      },

      "/api/notion-token": {
        PUT: guarded(async (req) => {
          const token = (await body(req)).token;
          if (typeof token !== "string" || !token.trim()) return json({ error: "Paste the token" }, 400);
          let workspace: string;
          try {
            workspace = await new NotionSource(token.trim()).whoAmI();
          } catch (e) {
            return json({ error: describeNotionError(e) }, 400);
          }
          settings = await updateSettings({ notionToken: token.trim(), notionWorkspace: workspace });
          publishPanel({ type: "manifest" });
          return json({ workspace });
        }),
        DELETE: guarded(async () => {
          settings = await updateSettings({ notionToken: null, notionWorkspace: null });
          publishPanel({ type: "manifest" });
          return json({ ok: true });
        }),
      },

      "/api/pick-folder": {
        POST: guarded(async () => {
          try {
            return json({ path: await pickFolder() });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 501);
          }
        }),
      },

      "/images/:file": async (req) => {
        const name = req.params.file;
        if (!active || !CACHE_FILE_RE.test(name)) return new Response("Not found", { status: 404 });
        const path = isLocalProject(active) ? folderFiles.get(name) : join(projectDir(active.id), "images", name);
        if (!path) return new Response("Not found", { status: 404 });
        const file = Bun.file(path);
        if (!(await file.exists())) return new Response("Not found", { status: 404 });
        return new Response(file, {
          headers: {
            "Content-Type": file.type,
            // File names contain a content-version hash, so they never change.
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },

      "/ws": (req, srv) => {
        if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
        const role = new URL(req.url).searchParams.get("role") === "screen" ? "screen" : "panel";
        if (role === "panel" && !authorized(req)) return new Response("Forbidden", { status: 403 });
        if (srv.upgrade(req, { data: { role } })) return undefined;
        return new Response("Expected a WebSocket", { status: 426 });
      },
    },

    fetch() {
      return new Response("Not found", { status: 404 });
    },

    websocket: {
      data: {} as WsData,
      idleTimeout: 120,
      sendPings: true,
      open(ws: Ws) {
        ws.subscribe(ws.data.role);
        if (ws.data.role === "screen") {
          ws.send(JSON.stringify({ type: "view", view: screenView() } satisfies ScreenMessage));
          publishPanel(panelStateMessage()); // screen count changed
        } else {
          ws.send(JSON.stringify(panelStateMessage()));
          ws.send(JSON.stringify({ type: "sync", status: syncStatus } satisfies PanelMessage));
        }
      },
      message(ws: Ws, raw) {
        let msg: unknown;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if (ws.data.role === "panel") {
          handlePanelCommand(msg as PanelCommand);
        } else {
          const hello = msg as ScreenHello;
          if (hello.type === "viewport" && hello.width > 0 && hello.height > 0) {
            screenAspect = clamp(hello.width / hello.height, 0.5, 4);
            publishPanel(panelStateMessage());
          }
        }
      },
      close(ws: Ws) {
        ws.unsubscribe(ws.data.role);
        if (ws.data.role === "screen") publishPanel(panelStateMessage());
      },
    },
  });
}
