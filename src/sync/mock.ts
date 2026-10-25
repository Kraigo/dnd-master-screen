// Mock source for development: builds the cache from local images instead of
// Notion. Enabled with MOCK=1; images are read from MOCK_DIR (default ./fixtures).
// With no images there, it generates abstract SVG placeholders.

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ROOT, type GroupConfig } from "../config.ts";
import { extFromName, type ImageData } from "./download.ts";
import type { ImageSource, PlannedItem } from "./source.ts";

interface Fixture {
  name: string;
  load: () => Promise<ImageData>;
  mtime: string;
}

const NAMES: Record<string, string[]> = {
  characters: ["Elder Yaropolk", "Herbalist Veleslava", "Captain of the Guard", "Wanderer in Grey", "Miller Gordey"],
  locations: ["City Gate", "The Dry Well Tavern", "Old Mill", "Riverside Temple", "Forest Path"],
  items: ["Brimor Amulet", "Rusty Key", "Sealed Letter", "Keeper's Lantern", "Smugglers' Map"],
};

function fakeId(seed: string): string {
  const h = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function placeholderSvg(i: number): string {
  // Muted ochre / slate / moss washes, no text (the players' screen must stay text-free).
  const palettes = [
    ["#3d4a52", "#b08a4a", "#6f7a52"],
    ["#4a3f35", "#8c9a86", "#c2a46a"],
    ["#2f3b3a", "#a3714a", "#7d8f8c"],
    ["#45424f", "#9aa36b", "#c9b48a"],
  ];
  const [bg, a, b] = palettes[i % palettes.length]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<defs><filter id="f"><feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="3" seed="${i + 3}"/>
<feDisplacementMap in="SourceGraphic" scale="140"/><feGaussianBlur stdDeviation="6"/></filter></defs>
<rect width="1600" height="1000" fill="${bg}"/>
<g filter="url(#f)" opacity="0.85">
<ellipse cx="${520 + i * 90}" cy="460" rx="420" ry="300" fill="${a}"/>
<ellipse cx="${1080 - i * 60}" cy="560" rx="360" ry="260" fill="${b}"/>
</g></svg>`;
}

async function loadFixtures(dir: string): Promise<Fixture[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => !n.startsWith(".") && extFromName(n)).sort();
  } catch {
    names = [];
  }
  if (names.length > 0) {
    return Promise.all(
      names.map(async (name): Promise<Fixture> => {
        const path = join(dir, name);
        const s = await stat(path);
        return {
          name,
          mtime: `${s.mtime.toISOString()}#${s.size}`,
          load: async () => ({ bytes: new Uint8Array(await Bun.file(path).arrayBuffer()), ext: extFromName(name)! }),
        };
      }),
    );
  }
  return [0, 1, 2, 3].map((i) => ({
    name: `placeholder-${i + 1}.svg`,
    mtime: "placeholder-v1",
    load: async () => ({ bytes: new TextEncoder().encode(placeholderSvg(i)), ext: "svg" }),
  }));
}

export class MockSource implements ImageSource {
  readonly dir: string;
  private fixtures: Promise<Fixture[]> | null = null;
  private warned = false;

  constructor(dir = process.env.MOCK_DIR) {
    this.dir = resolve(ROOT, dir || "fixtures");
  }

  async listGroup(group: GroupConfig, log: (msg: string) => void): Promise<PlannedItem[]> {
    this.fixtures ??= loadFixtures(this.dir);
    const fx = await this.fixtures;
    if (!this.warned && fx[0]?.name.startsWith("placeholder-")) {
      this.warned = true;
      log(`  MOCK: no images in ${this.dir}, drawing placeholders`);
    }
    const out: PlannedItem[] = [];
    group.sources.forEach((source, si) => {
      const seed = `${group.id}/${si}`;
      const make = (f: Fixture, label: string, kind: "cover" | "block"): PlannedItem => ({
        id: fakeId(`${seed}/${f.name}`),
        label,
        sourcePageId: fakeId(seed),
        kind,
        lastEditedTime: f.mtime,
        fetchImage: f.load,
      });
      if (source.type === "dataSource") {
        const names = NAMES[group.id] ?? [];
        fx.forEach((f, i) => out.push(make(f, names[i] ?? `${group.label} ${i + 1}`, "cover")));
        out.push({
          id: fakeId(`${seed}/no-cover`),
          label: "No cover",
          sourcePageId: fakeId(seed),
          kind: "cover",
          lastEditedTime: "mock",
          fetchImage: null,
        });
      } else if (source.type === "pageImages") {
        fx.forEach((f, i) => out.push(make(f, i === 0 ? "City map" : `City ${i + 1}`, "block")));
      } else {
        const f = fx[fx.length - 1];
        if (f) out.push(make(f, source.label || "Cover", "cover"));
      }
    });
    return out;
  }
}
