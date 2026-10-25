// Sync orchestrator shared by the CLI (`bun run sync`) and POST /api/sync.
// Lists every configured group, downloads changed images into cache/images,
// writes cache/manifest.json and removes files no longer referenced.

import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { IMAGES_DIR, loadConfig } from "../config.ts";
import { readManifest, writeManifest } from "../manifest.ts";
import type { Manifest, ManifestGroup, ManifestItem, SyncStatus } from "../shared/types.ts";
import { cacheFileName } from "./download.ts";
import type { ImageSource, PlannedItem } from "./source.ts";

export interface SyncOptions {
  mock?: boolean;
  log?: (msg: string) => void;
  onProgress?: (status: SyncStatus) => void;
}

const CONCURRENCY = 4;

/** Every group failed; the message is already human-readable. */
class NothingReadError extends Error {}

export function idleStatus(): SyncStatus {
  return {
    running: false,
    phase: "idle",
    done: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    downloaded: 0,
    skipped: 0,
    removed: 0,
    failures: [],
    message: null,
  };
}

export function isMockMode(): boolean {
  const v = (process.env.MOCK ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function makeSource(mock: boolean, log: (m: string) => void): Promise<ImageSource> {
  if (mock) {
    const { MockSource } = await import("./mock.ts");
    const src = new MockSource();
    log(`MOCK: images from ${src.dir}`);
    return src;
  }
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) throw new Error("NOTION_TOKEN is not set. Copy .env.example to .env and paste the integration token");
  const { NotionSource } = await import("./notion.ts");
  return new NotionSource(token);
}

async function describeError(e: unknown, mock: boolean): Promise<string> {
  if (mock || e instanceof NothingReadError) return e instanceof Error ? e.message : String(e);
  const { describeNotionError } = await import("./notion.ts");
  return describeNotionError(e);
}

async function fileExists(name: string | null): Promise<boolean> {
  return name !== null && (await Bun.file(join(IMAGES_DIR, name)).exists());
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runSync(opts: SyncOptions = {}): Promise<SyncStatus> {
  const mock = opts.mock ?? isMockMode();
  const log = opts.log ?? ((m: string) => console.log(m));
  const status: SyncStatus = { ...idleStatus(), running: true, phase: "listing", startedAt: new Date().toISOString() };
  const emit = () => opts.onProgress?.({ ...status, failures: [...status.failures] });
  emit();

  try {
    await mkdir(IMAGES_DIR, { recursive: true });
    const config = await loadConfig();
    const source = await makeSource(mock, log);
    const prevRaw = await readManifest();
    const prev = prevRaw && prevRaw.mode === (mock ? "mock" : "notion") ? prevRaw : null;
    const prevItems = new Map<string, ManifestItem>();
    for (const g of prev?.groups ?? []) for (const it of g.items) prevItems.set(it.id, it);

    // 1. List all groups. A group that fails keeps its previous items.
    const planned: { group: ManifestGroup; plan: PlannedItem[] }[] = [];
    for (const g of config.groups) {
      log(`Reading "${g.label}"...`);
      status.message = `Reading "${g.label}"`;
      emit();
      try {
        const plan = await source.listGroup(g, log);
        planned.push({ group: { id: g.id, label: g.label, items: [] }, plan });
        log(`  found: ${plan.length}`);
      } catch (e) {
        const msg = await describeError(e, mock);
        log(`  ERROR "${g.label}": ${msg}`);
        status.failures.push({ label: g.label, error: msg });
        const old = prev?.groups.find((pg) => pg.id === g.id);
        planned.push({ group: { id: g.id, label: g.label, items: old?.items ?? [], error: msg }, plan: [] });
      }
    }

    // Nothing could be read (offline, wrong token, integration not connected):
    // leave the existing cache untouched instead of replacing it with an empty one.
    if (planned.every((p) => p.group.error)) {
      throw new NothingReadError(`Could not read any section: ${status.failures[0]?.error ?? "unknown error"}`);
    }

    // 2. Download what changed.
    status.phase = "downloading";
    status.total = planned.reduce((n, p) => n + p.plan.length, 0);
    status.message = "Downloading images";
    emit();

    const results = new Map<PlannedItem, ManifestItem>();
    const all = planned.flatMap((p) => p.plan);
    await runPool(all, CONCURRENCY, async (item) => {
      const base: ManifestItem = {
        id: item.id,
        label: item.label,
        file: null,
        sourcePageId: item.sourcePageId,
        kind: item.kind,
        lastEditedTime: item.lastEditedTime,
      };
      const old = prevItems.get(item.id);
      try {
        if (!item.fetchImage) {
          results.set(item, base);
        } else if (old && !old.failed && old.lastEditedTime === item.lastEditedTime && (await fileExists(old.file))) {
          results.set(item, { ...base, file: old.file });
          status.skipped += 1;
        } else {
          const img = await item.fetchImage();
          const file = cacheFileName(item.id, item.lastEditedTime, img.ext);
          const part = join(IMAGES_DIR, `${file}.part`);
          await Bun.write(part, img.bytes);
          await rename(part, join(IMAGES_DIR, file));
          results.set(item, { ...base, file });
          status.downloaded += 1;
          log(`  downloaded: ${item.label}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ERROR "${item.label}": ${msg}`);
        status.failures.push({ label: item.label, error: msg });
        // Keep the previous version of the image if we have one.
        if (old?.file && (await fileExists(old.file))) results.set(item, { ...base, file: old.file, lastEditedTime: old.lastEditedTime });
        else results.set(item, { ...base, failed: true });
      }
      status.done += 1;
      emit();
    });

    for (const p of planned) {
      if (p.plan.length > 0 || !p.group.error) p.group.items = p.plan.map((it) => results.get(it)!);
    }

    const manifest: Manifest = {
      version: 1,
      syncedAt: new Date().toISOString(),
      mode: mock ? "mock" : "notion",
      groups: planned.map((p) => p.group),
    };
    await writeManifest(manifest);

    // 3. Remove files nothing points to any more.
    const keep = new Set(manifest.groups.flatMap((g) => g.items.map((i) => i.file)).filter(Boolean));
    for (const name of await readdir(IMAGES_DIR)) {
      if (!keep.has(name)) {
        await unlink(join(IMAGES_DIR, name)).catch(() => {});
        status.removed += 1;
      }
    }

    status.phase = "done";
    status.message =
      status.failures.length === 0
        ? "Done"
        : `Done with errors: ${status.failures.length}`;
  } catch (e) {
    status.phase = "error";
    status.message = await describeError(e, mock);
    log(`ERROR: ${status.message}`);
  }
  status.running = false;
  status.finishedAt = new Date().toISOString();
  emit();
  return status;
}
