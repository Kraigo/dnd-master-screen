// App data on disk: settings, the project list and per-project caches.
// Lives outside the install folder so updating the app keeps everything.

import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Project } from "./shared/types.ts";

const APP_NAME = "DnD Master Screen";

function defaultDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", APP_NAME);
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), APP_NAME);
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), APP_NAME);
}

export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : defaultDataDir();
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const PROJECTS_PATH = join(DATA_DIR, "projects.json");

export interface Settings {
  activeProjectId: string | null;
  notionToken: string | null;
  /** Workspace name reported by Notion when the token was saved. */
  notionWorkspace: string | null;
  /** Other devices on the network may open the app (server listens on all interfaces). */
  lanEnabled: boolean;
  /** Hash (Bun.password) of the password other devices need for /master. */
  masterPasswordHash: string | null;
}

/** Cache folder of a Notion project (manifest.json + images/). */
export function projectDir(id: string): string {
  return join(DATA_DIR, "projects", id);
}

/** Per-image data of a project, item id -> string: fog.json (fog masks), ink.json (drawings). */
export async function readImageMap(id: string, file: "fog.json" | "ink.json"): Promise<Map<string, string>> {
  const data = await readJson<Record<string, unknown>>(join(projectDir(id), file));
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(data ?? {})) if (typeof v === "string") out.set(k, v);
  return out;
}

export async function writeImageMap(id: string, file: "fog.json" | "ink.json", map: Map<string, string>): Promise<void> {
  await mkdir(projectDir(id), { recursive: true });
  await writeJsonAtomic(join(projectDir(id), file), Object.fromEntries(map));
}

/** A recently shown image and the view it had (the recents palette). */
export interface RecentEntry {
  itemId: string;
  zoom: number;
  focusX: number;
  focusY: number;
}

export async function readRecent(id: string): Promise<RecentEntry[]> {
  const data = await readJson<unknown[]>(join(projectDir(id), "recent.json"));
  return (Array.isArray(data) ? data : []).filter(
    (r): r is RecentEntry =>
      !!r &&
      typeof (r as RecentEntry).itemId === "string" &&
      [(r as RecentEntry).zoom, (r as RecentEntry).focusX, (r as RecentEntry).focusY].every((n) => typeof n === "number"),
  );
}

export async function writeRecent(id: string, recent: RecentEntry[]): Promise<void> {
  await mkdir(projectDir(id), { recursive: true });
  await writeJsonAtomic(join(projectDir(id), "recent.json"), recent);
}

/** Write via a temp file + rename so a crash never leaves a half-written file. */
export async function writeJsonAtomic(path: string, data: unknown, mode?: number): Promise<void> {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  if (mode !== undefined) await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as T;
  } catch {
    return null;
  }
}

export async function ensureDataDir(): Promise<void> {
  await mkdir(join(DATA_DIR, "projects"), { recursive: true });
}

export async function readSettings(): Promise<Settings> {
  const s = await readJson<Partial<Settings>>(SETTINGS_PATH);
  return {
    activeProjectId: typeof s?.activeProjectId === "string" ? s.activeProjectId : null,
    notionToken: typeof s?.notionToken === "string" && s.notionToken ? s.notionToken : null,
    notionWorkspace: typeof s?.notionWorkspace === "string" ? s.notionWorkspace : null,
    masterPasswordHash: typeof s?.masterPasswordHash === "string" && s.masterPasswordHash ? s.masterPasswordHash : null,
    // Never expose the app without a password, even if the file was edited by hand.
    lanEnabled: s?.lanEnabled === true && typeof s?.masterPasswordHash === "string" && !!s.masterPasswordHash,
  };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  await ensureDataDir();
  // The file holds the Notion token and the password hash: keep it readable by the current user only.
  await writeJsonAtomic(SETTINGS_PATH, next, 0o600);
  return next;
}

function isProject(p: unknown): p is Project {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.name !== "string") return false;
  if (o.type === "folder" || o.type === "obsidian") return typeof o.path === "string";
  return o.type === "notion" && typeof o.rootPageId === "string";
}

export async function readProjects(): Promise<Project[]> {
  const list = await readJson<unknown[]>(PROJECTS_PATH);
  return Array.isArray(list) ? list.filter(isProject) : [];
}

export async function writeProjects(list: Project[]): Promise<void> {
  await ensureDataDir();
  await writeJsonAtomic(PROJECTS_PATH, list);
}

export function newProjectId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export async function removeProjectCache(id: string): Promise<void> {
  await rm(projectDir(id), { recursive: true, force: true });
}

/** Delete settings, the project list and all Notion caches. */
export async function clearData(): Promise<void> {
  await rm(join(DATA_DIR, "projects"), { recursive: true, force: true });
  await rm(SETTINGS_PATH, { force: true });
  await rm(PROJECTS_PATH, { force: true });
  await ensureDataDir();
}
