// dnd-master-screen server: DM control panel, players' screen, cached images and live state.
// At runtime it only reads cache/ — it never calls Notion unless the DM presses
// "Sync" (which runs the same code as `bun run sync`).

import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { IMAGES_DIR, MANIFEST_PATH } from "./config.ts";
import { readManifest } from "./manifest.ts";
import type {
  Manifest,
  PanelCommand,
  PanelMessage,
  ScreenHello,
  ScreenMessage,
  ScreenState,
  ScreenView,
  SyncStatus,
} from "./shared/types.ts";
import { clamp, MAX_ZOOM, MIN_ZOOM } from "./shared/view.ts";
import { CACHE_FILE_RE } from "./sync/download.ts";
import { idleStatus, isMockMode, runSync } from "./sync/index.ts";
import panelPage from "./panel/index.html";
import screenPage from "./screen/index.html";

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || "127.0.0.1";
const MOCK = isMockMode();

// ---------------------------------------------------------------------------
// Manifest (re-read when the file changes, e.g. after `bun run sync` in another terminal)

let manifest: Manifest | null = null;
let manifestMtime = -1;
let fileById = new Map<string, string>();

async function refreshManifest(): Promise<boolean> {
  const mtime = await stat(MANIFEST_PATH).then((s) => s.mtimeMs, () => 0);
  if (mtime === manifestMtime) return false;
  manifestMtime = mtime;
  manifest = mtime ? await readManifest() : null;
  fileById = new Map();
  for (const g of manifest?.groups ?? []) {
    for (const it of g.items) if (it.file && !fileById.has(it.id)) fileById.set(it.id, it.file);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Screen state

let state: ScreenState = { mode: "black", itemId: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
let screenAspect = 16 / 9;
let syncStatus: SyncStatus = idleStatus();

type WsData = { role: "panel" | "screen" };
type Ws = ServerWebSocket<WsData>;

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

function screenCount(): number {
  return server.subscriberCount("screen");
}

function panelStateMessage(): PanelMessage {
  return { type: "state", state, screens: screenCount(), aspect: screenAspect };
}

function publishPanel(msg: PanelMessage): void {
  server.publish("panel", JSON.stringify(msg));
}

function publishState(): void {
  const view: ScreenMessage = { type: "view", view: screenView() };
  server.publish("screen", JSON.stringify(view));
  publishPanel(panelStateMessage());
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

async function handlePanelCommand(cmd: PanelCommand): Promise<void> {
  switch (cmd.type) {
    case "show": {
      await refreshManifest();
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
// Sync

function startSync(): boolean {
  if (syncStatus.running) return false;
  syncStatus = { ...idleStatus(), running: true, phase: "listing", startedAt: new Date().toISOString() };
  void runSync({
    mock: MOCK,
    onProgress: (s) => {
      syncStatus = s;
      publishPanel({ type: "sync", status: s });
    },
  }).then(async () => {
    await refreshManifest();
    publishPanel({ type: "manifest" });
    publishState();
  });
  return true;
}

// ---------------------------------------------------------------------------
// HTTP

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

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": screenPage,
    "/admin": panelPage,

    "/api/manifest": {
      GET: async () => {
        await refreshManifest();
        return json({ manifest, mock: MOCK, sync: syncStatus });
      },
    },

    "/api/sync": {
      GET: () => json(syncStatus),
      POST: (req) => {
        if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
        const started = startSync();
        return json({ started, status: syncStatus }, started ? 202 : 409);
      },
    },

    "/images/:file": async (req) => {
      const name = req.params.file;
      if (!CACHE_FILE_RE.test(name)) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(IMAGES_DIR, name));
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
    async open(ws: Ws) {
      ws.subscribe(ws.data.role);
      await refreshManifest();
      if (ws.data.role === "screen") {
        ws.send(JSON.stringify({ type: "view", view: screenView() } satisfies ScreenMessage));
        publishPanel(panelStateMessage()); // screen count changed
      } else {
        ws.send(JSON.stringify(panelStateMessage()));
        ws.send(JSON.stringify({ type: "sync", status: syncStatus } satisfies PanelMessage));
      }
    },
    async message(ws: Ws, raw) {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (ws.data.role === "panel") {
        await handlePanelCommand(msg as PanelCommand);
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

await refreshManifest();

const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}`;
console.log(`dnd-master-screen${MOCK ? " (MOCK)" : ""}`);
console.log(`  Players' screen: ${base}/`);
console.log(`  DM panel:        ${base}/admin`);
if (HOST === "0.0.0.0") {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) console.log(`  On the LAN:      http://${a.address}:${server.port}/`);
    }
  }
}
if (!manifest) console.log(`  Cache is empty: run \`bun run sync\` or press "Sync" in the panel`);
