import { rename } from "node:fs/promises";
import { MANIFEST_PATH } from "./config.ts";
import type { Manifest } from "./shared/types.ts";

export async function readManifest(): Promise<Manifest | null> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) return null;
  try {
    const data = (await file.json()) as Manifest;
    if (data?.version !== 1 || !Array.isArray(data.groups)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Write via a temp file + rename so a crash never leaves a half-written manifest. */
export async function writeManifest(m: Manifest): Promise<void> {
  const tmp = `${MANIFEST_PATH}.tmp`;
  await Bun.write(tmp, JSON.stringify(m, null, 2));
  await rename(tmp, MANIFEST_PATH);
}
