// Obsidian projects: a vault (or a folder inside one) where images live anywhere
// (usually one attachments folder) and are tied to notes by embeds.
//
// - Tab = folder of the note that embeds the image, without a leading number
//   ("3 Characters" -> "Characters"); tabs keep the folder order.
// - Caption = the note's name ("Innkeeper", "Innkeeper 2", ...), or the embed's
//   caption (![[map.png|North side]]); a size like |420 is not a caption.
// - Images come from frontmatter properties that link to an image
//   (portrait: "[[x.png]]") and from ![[...]] / ![](...) embeds in the body.
// - Images no note embeds go to the "Unlinked" tab.
// - The templates folder from the vault settings is skipped.
//
// Note text is read only to find embeds; nothing of it is stored or sent.
// Served file names are opaque, as for folder projects.

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import type { Manifest, ManifestGroup, ManifestItem } from "../shared/types.ts";
import { extFromName, shortHash } from "../sync/download.ts";
import type { FolderScan } from "./folder.ts";

const MAX_DEPTH = 12;
const UNLINKED_GROUP = "Unlinked";
const ROOT_GROUP = "Notes";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** macOS and iCloud may store names decomposed (NFD) while note text is NFC. */
const nfc = (s: string) => s.normalize("NFC");

interface ImageFile {
  abs: string;
  /** Path relative to the scanned folder, "/"-separated, NFC. */
  rel: string;
  ext: string;
  mtime: number;
  size: number;
}

interface NoteFile {
  abs: string;
  rel: string;
}

interface Found {
  images: ImageFile[];
  notes: NoteFile[];
  /** Images that iCloud has offloaded (".name.png.icloud" placeholders), by rel path. */
  offloaded: Set<string>;
}

function toRel(root: string, abs: string): string {
  return nfc(relative(root, abs).split(sep).join("/"));
}

async function walk(root: string, dir: string, depth: number, skip: Set<string>, out: Found): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    const name = nfc(e.name);
    if (name.startsWith(".")) {
      // iCloud placeholder of a file that is not downloaded: ".photo.png.icloud"
      const m = /^\.(.+)\.icloud$/.exec(name);
      if (m && extFromName(m[1]!)) out.offloaded.add(toRel(root, join(dir, m[1]!)));
      continue;
    }
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !skip.has(toRel(root, abs))) await walk(root, abs, depth + 1, skip, out).catch(() => {});
      continue;
    }
    if (!(e.isFile() || e.isSymbolicLink())) continue;
    if (/\.md$/i.test(name)) {
      out.notes.push({ abs, rel: toRel(root, abs) });
      continue;
    }
    const ext = extFromName(name);
    if (!ext) continue;
    const s = await stat(abs).catch(() => null);
    if (!s?.isFile() || s.size === 0) continue;
    out.images.push({ abs, rel: toRel(root, abs), ext, mtime: s.mtimeMs, size: s.size });
  }
}

/** The vault root: the nearest folder (this one or a parent) that has a .obsidian folder. */
async function findVaultRoot(path: string): Promise<string | null> {
  let dir = path;
  for (let i = 0; i < 20; i++) {
    const s = await stat(join(dir, ".obsidian")).catch(() => null);
    if (s?.isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export async function isObsidianFolder(path: string): Promise<boolean> {
  return (await findVaultRoot(path)) !== null;
}

/** Templates folder from the vault settings, relative to the scanned folder ("" if outside it). */
async function templatesFolder(vaultRoot: string, root: string): Promise<string | null> {
  try {
    const cfg = (await Bun.file(join(vaultRoot, ".obsidian", "templates.json")).json()) as { folder?: unknown };
    if (typeof cfg.folder !== "string" || !cfg.folder.trim()) return null;
    const rel = toRel(root, join(vaultRoot, cfg.folder.trim()));
    return rel.startsWith("..") ? null : rel;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Links

interface Embed {
  target: string;
  /** Text after "|" in a wiki embed, or the alt text of a markdown embed. */
  caption: string;
  wiki: boolean;
}

/** A caption that is only a size (|420, |420x300) is not a caption. */
function realCaption(text: string): string {
  const t = text.trim();
  return /^\d+(x\d+)?$/i.test(t) ? "" : t;
}

function splitFrontmatter(text: string): { front: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { front: m[1]!, body: text.slice(m[0].length) } : { front: "", body: text };
}

function findEmbeds(text: string): Embed[] {
  const { front, body } = splitFrontmatter(text);
  const out: Embed[] = [];
  // Frontmatter properties: portrait: "[[x.png]]" (also in lists). Plain wikilinks here
  // count, because properties link to images without the "!".
  for (const m of front.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g)) {
    out.push({ target: m[1]!, caption: "", wiki: true });
  }
  // Body: skip fenced and inline code, where embeds are only examples.
  const prose = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of prose.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]|!\[([^\]]*)\]\(\s*<?([^)>]+?)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (m[1] !== undefined) out.push({ target: m[1], caption: realCaption(m[2] ?? ""), wiki: true });
    else out.push({ target: m[4]!, caption: realCaption(m[3] ?? ""), wiki: false });
  }
  return out;
}

class ImageIndex {
  private byRel = new Map<string, ImageFile>();
  private byName = new Map<string, ImageFile[]>();

  constructor(images: ImageFile[]) {
    for (const img of images) {
      this.byRel.set(img.rel.toLowerCase(), img);
      const key = posix.basename(img.rel).toLowerCase();
      const list = this.byName.get(key) ?? [];
      list.push(img);
      this.byName.set(key, list);
    }
  }

  /**
   * Resolve like Obsidian: a path relative to the note or to the vault, otherwise
   * the file name anywhere (same folder as the note first, then the shortest path).
   */
  resolve(embed: Embed, noteRel: string): ImageFile | null {
    let target = embed.target.trim();
    if (!embed.wiki) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // http(s), app links: not local files
      try {
        target = decodeURIComponent(target);
      } catch {
        // keep as typed
      }
    }
    target = nfc(target.replace(/\\/g, "/").replace(/^\/+/, ""));
    if (!extFromName(target)) return null;
    const noteDir = posix.dirname(noteRel);
    const candidates = [posix.normalize(posix.join(noteDir, target)), posix.normalize(target)];
    for (const c of candidates) {
      const hit = this.byRel.get(c.toLowerCase());
      if (hit) return hit;
    }
    const named = this.byName.get(posix.basename(target).toLowerCase()) ?? [];
    const suffix = target.includes("/") ? `/${target.toLowerCase()}` : null;
    const pool = suffix ? named.filter((f) => `/${f.rel.toLowerCase()}`.endsWith(suffix)) : named;
    if (!pool.length) return null;
    return [...pool].sort((a, b) => {
      const sameA = posix.dirname(a.rel) === noteDir ? 0 : 1;
      const sameB = posix.dirname(b.rel) === noteDir ? 0 : 1;
      return sameA - sameB || a.rel.split("/").length - b.rel.split("/").length || collator.compare(a.rel, b.rel);
    })[0]!;
  }
}

// ---------------------------------------------------------------------------
// Scan

function hashId(key: string): string {
  return new Bun.CryptoHasher("sha1").update(key).digest("hex").slice(0, 32);
}

function servedName(img: ImageFile): string {
  return `${hashId(`img:${img.rel}`)}-${shortHash(`${img.mtime}:${img.size}`)}.${img.ext}`;
}

/** "3 Characters" -> "Characters", "01. Maps" -> "Maps". */
function tabLabel(folder: string): string {
  return folder.replace(/^\d+\s*[.)_-]?\s*/, "") || folder;
}

interface Placed {
  noteName: string;
  order: number;
  item: ManifestItem;
}

export async function scanObsidian(root: string): Promise<FolderScan> {
  const s = await stat(root).catch(() => null);
  if (!s) throw new Error(`Folder not found: ${root}`);
  if (!s.isDirectory()) throw new Error(`Not a folder: ${root}`);

  const vaultRoot = (await findVaultRoot(root)) ?? root;
  const skip = new Set<string>();
  const templates = await templatesFolder(vaultRoot, root);
  if (templates) skip.add(templates);

  const found: Found = { images: [], notes: [], offloaded: new Set() };
  await walk(root, root, 0, skip, found);
  const index = new ImageIndex(found.images);

  const files = new Map<string, string>();
  const used = new Set<string>();
  const groups = new Map<string, Placed[]>();

  for (const note of found.notes) {
    const text = await Bun.file(note.abs).text().catch(() => "");
    if (!text) continue;
    const noteName = nfc(basename(note.abs)).replace(/\.md$/i, "");
    const folder = posix.dirname(note.rel);
    /** Items of this note by image, to pick up a caption given by a later embed of the same image. */
    const seen = new Map<string, { item: ManifestItem; captioned: boolean }>();
    let n = 0;
    for (const embed of findEmbeds(text)) {
      const img = index.resolve(embed, note.rel);
      const key = img?.rel ?? `missing:${nfc(embed.target)}`;
      const earlier = seen.get(key);
      if (earlier) {
        if (embed.caption && !earlier.captioned) {
          earlier.item.label = embed.caption;
          earlier.captioned = true;
        }
        continue;
      }
      if (!img) {
        // Report only broken links to local image files (not other notes, not web images).
        if (!extFromName(embed.target) || /^[a-z][a-z0-9+.-]*:/i.test(embed.target.trim())) continue;
        // A broken link to an image: show it greyed out so the DM notices.
        n += 1;
        const offloaded = [...found.offloaded].some((r) => posix.basename(r) === posix.basename(nfc(embed.target)));
        const item: ManifestItem = {
          id: hashId(`note:${note.rel}#${key}`),
          label: embed.caption || (n > 1 ? `${noteName} ${n}` : noteName),
          file: null,
          sourcePageId: folder,
          kind: "note",
          lastEditedTime: "",
          missing: offloaded ? "offloaded" : "not-found",
        };
        seen.set(key, { item, captioned: !!embed.caption });
        groups.set(folder, [...(groups.get(folder) ?? []), { noteName, order: n, item }]);
        continue;
      }
      used.add(img.rel);
      n += 1;
      const name = servedName(img);
      files.set(name, img.abs);
      const item: ManifestItem = {
        id: hashId(`note:${note.rel}#${img.rel}`),
        label: embed.caption || (n > 1 ? `${noteName} ${n}` : noteName),
        file: name,
        sourcePageId: folder,
        kind: "note",
        lastEditedTime: new Date(img.mtime).toISOString(),
      };
      seen.set(key, { item, captioned: !!embed.caption });
      groups.set(folder, [...(groups.get(folder) ?? []), { noteName, order: n, item }]);
    }
  }

  const out: ManifestGroup[] = [];
  // Category folders first, in folder order; notes lying directly in the chosen folder after them.
  const folders = [...groups.keys()].sort((a, b) => Number(a === ".") - Number(b === ".") || collator.compare(a, b));
  for (const folder of folders) {
    const placed = groups.get(folder)!;
    placed.sort((a, b) => collator.compare(a.noteName, b.noteName) || a.order - b.order);
    const label = folder === "." ? ROOT_GROUP : tabLabel(posix.basename(folder));
    out.push({ id: `note:${folder}`, label, items: placed.map((p) => p.item) });
  }

  const unlinked = found.images.filter((img) => !used.has(img.rel)).sort((a, b) => collator.compare(a.rel, b.rel));
  if (unlinked.length) {
    out.push({
      id: "unlinked",
      label: UNLINKED_GROUP,
      items: unlinked.map((img) => {
        const name = servedName(img);
        files.set(name, img.abs);
        return {
          id: hashId(`img:${img.rel}`),
          label: posix.basename(img.rel).replace(/\.[^.]+$/, ""),
          file: name,
          sourcePageId: posix.dirname(img.rel),
          kind: "file",
          lastEditedTime: new Date(img.mtime).toISOString(),
        };
      }),
    });
  }

  const manifest: Manifest = { version: 1, syncedAt: new Date().toISOString(), mode: "obsidian", groups: out };
  return { manifest, files };
}
