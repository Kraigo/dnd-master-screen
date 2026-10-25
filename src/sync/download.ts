// Helpers for fetching images and naming cached files.

export interface ImageData {
  bytes: Uint8Array;
  ext: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"]);

export function extFromName(name: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (!m?.[1]) return null;
  const ext = m[1].toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  return ext === "jpeg" ? "jpg" : ext;
}

function extFromUrl(url: string): string | null {
  try {
    return extFromName(decodeURIComponent(new URL(url).pathname));
  } catch {
    return null;
  }
}

/** Notion's built-in gallery covers can come back as site-relative paths. */
export function absolutizeNotionUrl(url: string): string {
  if (url.startsWith("/")) return `https://www.notion.so${url}`;
  return url;
}

/**
 * Download an image right away. Notion "file" URLs are signed and expire after
 * about an hour, so they are used once here and never stored.
 */
export async function downloadImage(rawUrl: string): Promise<ImageData> {
  const url = absolutizeNotionUrl(rawUrl);
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading the image`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = EXT_BY_TYPE[type] ?? extFromUrl(url);
  if (!ext) throw new Error(`not an image (content-type: ${type || "none"})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("empty file");
  return { bytes, ext };
}

/** Short stable hash used in file names, so a changed image gets a new URL. */
export function shortHash(input: string): string {
  return new Bun.CryptoHasher("sha1").update(input).digest("hex").slice(0, 10);
}

export function cacheFileName(id: string, versionKey: string, ext: string): string {
  const safeId = id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40) || "item";
  return `${safeId}-${shortHash(versionKey)}.${ext}`;
}

/** Names that /images/:file is allowed to serve. */
export const CACHE_FILE_RE = /^[a-z0-9]{1,40}-[0-9a-f]{10}\.(jpg|png|gif|webp|avif|svg)$/;
