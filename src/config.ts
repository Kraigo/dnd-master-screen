import { join, resolve } from "node:path";

// Project root = the folder that contains package.json (one level above src/).
export const ROOT = resolve(import.meta.dir, "..");
export const CACHE_DIR = join(ROOT, "cache");
export const IMAGES_DIR = join(CACHE_DIR, "images");
export const MANIFEST_PATH = join(CACHE_DIR, "manifest.json");
export const CONFIG_PATH = join(ROOT, "panel.config.json");

export type SourceConfig =
  /** Every page of a Notion data source; image = page cover, label = title property. */
  | { type: "dataSource"; dataSourceId: string; titleProperty?: string }
  /** Top-level image blocks of one page; label = caption or "<page title> N". */
  | { type: "pageImages"; pageId: string }
  /** The cover of a single page. */
  | { type: "pageCover"; pageId: string; label?: string };

export interface GroupConfig {
  id: string;
  label: string;
  sources: SourceConfig[];
}

export interface PanelConfig {
  groups: GroupConfig[];
}

function fail(msg: string): never {
  throw new Error(`panel.config.json: ${msg}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(`${where} must be a non-empty string`);
  return v.trim();
}

function parseSource(raw: unknown, where: string): SourceConfig {
  if (!raw || typeof raw !== "object") fail(`${where} must be an object`);
  const s = raw as Record<string, unknown>;
  switch (s.type) {
    case "dataSource":
      return {
        type: "dataSource",
        dataSourceId: str(s.dataSourceId, `${where}.dataSourceId`),
        titleProperty: typeof s.titleProperty === "string" ? s.titleProperty : undefined,
      };
    case "pageImages":
      return { type: "pageImages", pageId: str(s.pageId, `${where}.pageId`) };
    case "pageCover":
      return {
        type: "pageCover",
        pageId: str(s.pageId, `${where}.pageId`),
        label: typeof s.label === "string" ? s.label : undefined,
      };
    default:
      fail(`${where}.type must be "dataSource", "pageImages" or "pageCover"`);
  }
}

export async function loadConfig(): Promise<PanelConfig> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) fail(`not found at ${CONFIG_PATH}`);
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (e) {
    fail(`invalid JSON (${(e as Error).message})`);
  }
  const groupsRaw = (raw as { groups?: unknown }).groups;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) fail("groups must be a non-empty array");
  const seen = new Set<string>();
  const groups = groupsRaw.map((g, i): GroupConfig => {
    const where = `groups[${i}]`;
    if (!g || typeof g !== "object") fail(`${where} must be an object`);
    const o = g as Record<string, unknown>;
    const id = str(o.id, `${where}.id`);
    if (seen.has(id)) fail(`duplicate group id "${id}"`);
    seen.add(id);
    if (!Array.isArray(o.sources)) fail(`${where}.sources must be an array`);
    return {
      id,
      label: str(o.label, `${where}.label`),
      sources: o.sources.map((s, j) => parseSource(s, `${where}.sources[${j}]`)),
    };
  });
  return { groups };
}
