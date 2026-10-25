// dnd-master-screen server: DM control panel, players' screen, project images and live state.
// Showing images never talks to Notion: Notion projects are served from their cache,
// folder projects straight from the folder. Notion is contacted only on "Sync".
//
// The players' screen ("/") may be opened from another device when HOST=0.0.0.0.
// The panel's API, its WebSocket, the folder dialog and the token answer only to
// the machine the server runs on, so the panel page is useless from the LAN.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { readManifest } from "./manifest.ts";
import { pickFolder } from "./os/pick-folder.ts";
import { folderName, scanFolder, watchFolder } from "./projects/folder.ts";
import type {
  AppState,
  Manifest,
  PanelCommand,
  PanelMessage,
  Project,
  ScreenHello,
  ScreenMessage,
  ScreenState,
  ScreenView,
  SyncStatus,
} from "./shared/types.ts";
import { clamp, MAX_ZOOM, MIN_ZOOM } from "./shared/view.ts";
import {
  ensureDataDir,
  newProjectId,
  projectDir,
  readProjects,
  readSettings,
  removeProjectCache,
  updateSettings,
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
let settings: Settings = { activeProjectId: null, notionToken: null, notionWorkspace: null };
let active: Project | null = null;
let manifest: Manifest | null = null;
let folderError: string | null = null;
/** Folder projects: served name -> absolute path. Only these names are ever served. */
let folderFiles = new Map<string, string>();
let fileById = new Map<string, string>();
let stopWatching: (() => void) | null = null;

let state: ScreenState = { mode: "black", itemId: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
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
  } else if (active.type === "folder") {
    try {
      const scan = await scanFolder(active.path);
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
  state = { mode: "black", itemId: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
  if (settings.activeProjectId !== (project?.id ?? null)) {
    settings = await updateSettings({ activeProjectId: project?.id ?? null });
  }
  await loadLibrary();
  if (project?.type === "folder") {
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

function appState(): AppState {
  return {
    projects,
    activeProjectId: active?.id ?? null,
    manifest,
    folderError,
    sync: syncStatus,
    notion: { tokenSet: !!settings.notionToken, workspace: settings.notionWorkspace },
  };
}

// ---------------------------------------------------------------------------
// Screen state

function screenView(): ScreenView {
  const file = state.itemId ? fileById.get(state.itemId) : undefined;
  return {
    mode: file ? state.mode : "black",
    src: file ? `/images/${file}` : null,
    zoom: state.zoom,
    focusX: state.focusX,
    focusY: state.focusY,
  };
}

function panelStateMessage(): PanelMessage {
  return { type: "state", state, screens: server?.subscriberCount("screen") ?? 0, aspect: screenAspect };
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
  switch (cmd.type) {
    case "show": {
      if (typeof cmd.itemId !== "string" || !fileById.has(cmd.itemId)) return;
      state = { mode: "image", itemId: cmd.itemId, zoom: 1, focusX: 0.5, focusY: 0.5 };
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
    default:
      return;
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

/** Admin endpoints: local machine only, and same-origin for anything that changes state. */
function admin(handler: (req: Req) => Response | Promise<Response>) {
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
    return { id: newProjectId(), name: name || folderName(path), type: "folder", path };
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
// Server

export async function startServer(opts: { hostname: string; port: number }): Promise<Server<WsData>> {
  await ensureDataDir();
  projects = await readProjects();
  settings = await readSettings();

  server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    development: process.env.NODE_ENV !== "production" && !COMPILED,
    routes: {
      "/": screenPage,
      "/admin": panelPage,

      "/api/health": () => json({ app: APP_ID }),

      "/api/state": { GET: admin(() => json(appState())) },

      "/api/projects": {
        POST: admin(async (req) => {
          const created = await createProject(await body(req));
          if (typeof created === "string") return json({ error: created }, 400);
          projects = [...projects, created];
          await saveProjects();
          await activate(created);
          if (created.type === "notion" && settings.notionToken) startSync(created);
          return json({ project: created }, 201);
        }),
      },

      "/api/projects/:id": {
        PATCH: admin(async (req) => {
          const p = findProject(req.params.id);
          if (!p) return json({ error: "Project not found" }, 404);
          const name = (await body(req)).name;
          if (typeof name !== "string" || !name.trim()) return json({ error: "Name cannot be empty" }, 400);
          projects = projects.map((x) => (x.id === p.id ? { ...x, name: name.trim() } : x));
          if (active?.id === p.id) active = findProject(p.id)!;
          await saveProjects();
          return json({ ok: true });
        }),
        DELETE: admin(async (req) => {
          const p = findProject(req.params.id);
          if (!p) return json({ error: "Project not found" }, 404);
          if (syncStatus.running && syncStatus.projectId === p.id) return json({ error: "Wait for the sync to finish" }, 409);
          projects = projects.filter((x) => x.id !== p.id);
          await saveProjects();
          // Only our own cache is removed; a linked folder is never touched.
          await removeProjectCache(p.id);
          if (active?.id === p.id) await activate(projects[0] ?? null);
          return json({ ok: true });
        }),
      },

      "/api/projects/:id/activate": {
        POST: admin(async (req) => {
          const p = findProject(req.params.id);
          if (!p) return json({ error: "Project not found" }, 404);
          await activate(p);
          return json({ ok: true });
        }),
      },

      // Notion: download from Notion. Folder: rescan (normally the folder is watched).
      "/api/projects/:id/sync": {
        POST: admin(async (req) => {
          const p = findProject(req.params.id);
          if (!p) return json({ error: "Project not found" }, 404);
          if (p.type === "folder") {
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
        PUT: admin(async (req) => {
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
        DELETE: admin(async () => {
          settings = await updateSettings({ notionToken: null, notionWorkspace: null });
          publishPanel({ type: "manifest" });
          return json({ ok: true });
        }),
      },

      "/api/pick-folder": {
        POST: admin(async () => {
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
        const path = active.type === "folder" ? folderFiles.get(name) : join(projectDir(active.id), "images", name);
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
        if (role === "panel" && !isLocal(req)) return new Response("Forbidden", { status: 403 });
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

  await activate(findProject(settings.activeProjectId) ?? projects[0] ?? null);
  return server;
}
