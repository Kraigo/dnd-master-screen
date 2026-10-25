// Notion sync for one project, started from the DM panel.
// Discovers the tabs under the campaign root page, downloads changed images into
// <project dir>/images, writes <project dir>/manifest.json and removes files no
// longer referenced.

import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readManifest, writeManifest } from "../manifest.ts";
import type { Manifest, ManifestGroup, ManifestItem, SyncStatus } from "../shared/types.ts";
import { cacheFileName } from "./download.ts";
import { describeNotionError, NotionSource } from "./notion.ts";
import type { PlannedGroup, PlannedItem } from "./source.ts";

export interface SyncOptions {
  projectId: string;
  token: string;
  rootPageId: string;
  /** Cache folder of the project. */
  dir: string;
  log?: (msg: string) => void;
  onProgress?: (status: SyncStatus) => void;
}

const CONCURRENCY = 4;

/** Every group failed; the message is already human-readable. */
class NothingReadError extends Error {}

export function idleStatus(): SyncStatus {
  return {
    projectId: null,
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

function describeError(e: unknown): string {
  if (e instanceof NothingReadError) return e.message;
  return describeNotionError(e);
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

export async function runSync(opts: SyncOptions): Promise<SyncStatus> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const imagesDir = join(opts.dir, "images");
  const status: SyncStatus = { ...idleStatus(), projectId: opts.projectId, running: true, phase: "listing", startedAt: new Date().toISOString() };
  const emit = () => opts.onProgress?.({ ...status, failures: [...status.failures] });
  const fileExists = async (name: string | null) => name !== null && (await Bun.file(join(imagesDir, name)).exists());
  emit();

  try {
    await mkdir(imagesDir, { recursive: true });
    const source = new NotionSource(opts.token);
    const prev = await readManifest(opts.dir);
    const prevItems = new Map<string, ManifestItem>();
    for (const g of prev?.groups ?? []) for (const it of g.items) prevItems.set(it.id, it);

    status.message = "Reading the campaign page";
    emit();
    const discovered: PlannedGroup[] = await source.listGroups(opts.rootPageId, log);

    // 1. List all groups. A group that fails keeps its previous items.
    const planned: { group: ManifestGroup; plan: PlannedItem[]; hideIfEmpty: boolean }[] = [];
    for (const g of discovered) {
      log(`Reading "${g.label}"...`);
      status.message = `Reading "${g.label}"`;
      emit();
      try {
        const plan = await g.list();
        planned.push({ group: { id: g.id, label: g.label, items: [] }, plan, hideIfEmpty: !!g.hideIfEmpty });
        log(`  found: ${plan.length}`);
      } catch (e) {
        const msg = describeError(e);
        log(`  ERROR "${g.label}": ${msg}`);
        status.failures.push({ label: g.label, error: msg });
        const old = prev?.groups.find((pg) => pg.id === g.id);
        planned.push({ group: { id: g.id, label: g.label, items: old?.items ?? [], error: msg }, plan: [], hideIfEmpty: false });
      }
    }

    // Nothing could be read (offline, integration not connected to the databases):
    // leave the existing cache untouched instead of replacing it with an empty one.
    if (planned.length > 0 && planned.every((p) => p.group.error)) {
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
          const part = join(imagesDir, `${file}.part`);
          await Bun.write(part, img.bytes);
          await rename(part, join(imagesDir, file));
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
      mode: "notion",
      groups: planned.filter((p) => !(p.hideIfEmpty && p.group.items.length === 0)).map((p) => p.group),
    };
    await writeManifest(opts.dir, manifest);

    // 3. Remove files nothing points to any more.
    const keep = new Set(manifest.groups.flatMap((g) => g.items.map((i) => i.file)).filter(Boolean));
    for (const name of await readdir(imagesDir)) {
      if (!keep.has(name)) {
        await unlink(join(imagesDir, name)).catch(() => {});
        status.removed += 1;
      }
    }

    status.phase = "done";
    status.message = status.failures.length === 0 ? "Done" : `Done with errors: ${status.failures.length}`;
  } catch (e) {
    status.phase = "error";
    status.message = describeError(e);
    log(`ERROR: ${status.message}`);
  }
  status.running = false;
  status.finishedAt = new Date().toISOString();
  emit();
  return status;
}
