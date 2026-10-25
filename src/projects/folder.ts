// Folder projects: images are read straight from a folder the DM picked, never copied.
// Top-level images go to the "All" tab, every subfolder becomes its own tab
// (files in deeper folders count towards their top-level subfolder).
//
// The players' screen must not learn file names, so each image is served under an
// opaque name (hash of the relative path + hash of mtime/size). Only names produced
// by the last scan are served; requests can never reach an arbitrary path.

import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { Manifest, ManifestGroup, ManifestItem } from "../shared/types.ts";
import { extFromName, shortHash } from "../sync/download.ts";

const MAX_DEPTH = 8;
const ROOT_GROUP = "All";

interface FoundFile {
  abs: string;
  rel: string;
  /** Top-level subfolder, or null for files directly in the project folder. */
  top: string | null;
  label: string;
  ext: string;
  mtime: Date;
  size: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

async function walk(root: string, dir: string, depth: number, out: FoundFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(root, abs, depth + 1, out).catch(() => {});
      continue;
    }
    const ext = extFromName(e.name);
    if (!ext || !(e.isFile() || e.isSymbolicLink())) continue;
    const s = await stat(abs).catch(() => null);
    if (!s?.isFile() || s.size === 0) continue;
    const rel = relative(root, abs);
    const parts = rel.split(sep);
    out.push({
      abs,
      rel,
      top: parts.length > 1 ? parts[0]! : null,
      label: e.name.replace(/\.[^.]+$/, ""),
      ext,
      mtime: s.mtime,
      size: s.size,
    });
  }
}

export interface FolderScan {
  manifest: Manifest;
  /** Served file name -> absolute path. */
  files: Map<string, string>;
}

export async function scanFolder(root: string): Promise<FolderScan> {
  const s = await stat(root).catch(() => null);
  if (!s) throw new Error(`Folder not found: ${root}`);
  if (!s.isDirectory()) throw new Error(`Not a folder: ${root}`);

  const found: FoundFile[] = [];
  await walk(root, root, 0, found);

  const files = new Map<string, string>();
  const byGroup = new Map<string | null, ManifestItem[]>();
  for (const f of found) {
    // Relative paths always use "/" so ids are the same on macOS and Windows.
    const relKey = f.rel.split(sep).join("/");
    const id = new Bun.CryptoHasher("sha1").update(relKey).digest("hex").slice(0, 32);
    const name = `${id}-${shortHash(`${f.mtime.getTime()}:${f.size}`)}.${f.ext}`;
    files.set(name, f.abs);
    const list = byGroup.get(f.top) ?? [];
    list.push({
      id,
      label: f.label,
      file: name,
      sourcePageId: f.top ?? "",
      kind: "file",
      lastEditedTime: f.mtime.toISOString(),
    });
    byGroup.set(f.top, list);
  }

  const groups: ManifestGroup[] = [];
  const tops = [...byGroup.keys()].filter((k): k is string => k !== null).sort(collator.compare);
  for (const key of [null, ...tops]) {
    const items = byGroup.get(key);
    if (!items) continue;
    items.sort((a, b) => collator.compare(a.label, b.label));
    groups.push({ id: key === null ? "root" : `dir:${key}`, label: key ?? ROOT_GROUP, items });
  }

  return { manifest: { version: 1, syncedAt: new Date().toISOString(), mode: "folder", groups }, files };
}

export function folderName(path: string): string {
  return basename(path.replace(/[\\/]+$/, "")) || path;
}

/**
 * Watch a folder and call `onChange` (debounced) when anything inside changes.
 * Returns a function that stops watching. If the platform cannot watch, it is a no-op
 * and the DM uses the Rescan button.
 */
export function watchFolder(root: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | null = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 500);
  };
  try {
    watcher = watch(root, { recursive: true }, fire);
    watcher.on("error", fire); // e.g. the folder was removed: rescan reports it
  } catch {
    watcher = null;
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
