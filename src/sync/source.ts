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

/** A tab found in the source. `list` may fail on its own without failing the whole sync. */
export interface PlannedGroup {
  id: string;
  label: string;
  /** Drop the tab from the panel when it has no items. */
  hideIfEmpty?: boolean;
  list: () => Promise<PlannedItem[]>;
}

export interface ImageSource {
  /** Discover the tabs of a project. Throws if the project cannot be read at all. */
  listGroups(rootId: string, log: (msg: string) => void): Promise<PlannedGroup[]>;
}
