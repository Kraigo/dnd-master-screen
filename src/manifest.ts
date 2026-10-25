import { join } from "node:path";
import type { Manifest } from "./shared/types.ts";
import { writeJsonAtomic } from "./store.ts";

export function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

export async function readManifest(dir: string): Promise<Manifest | null> {
  const file = Bun.file(manifestPath(dir));
  if (!(await file.exists())) return null;
  try {
    const data = (await file.json()) as Manifest;
    if (data?.version !== 1 || !Array.isArray(data.groups)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function writeManifest(dir: string, m: Manifest): Promise<void> {
  await writeJsonAtomic(manifestPath(dir), m);
}
