import type { GroupConfig } from "../config.ts";
import type { ImageData } from "./download.ts";

/** One item discovered while listing a group, before its image is downloaded. */
export interface PlannedItem {
  id: string;
  label: string;
  sourcePageId: string;
  kind: "cover" | "block";
  lastEditedTime: string;
  /** null = the page has no cover / no image. */
  fetchImage: (() => Promise<ImageData>) | null;
}

export interface ImageSource {
  /** List every item of a group. Throws if the group cannot be read at all. */
  listGroup(group: GroupConfig, log: (msg: string) => void): Promise<PlannedItem[]>;
}
