// Types shared by the server, the sync code and both browser pages.

export interface ManifestItem {
  /** Stable id: Notion page id (covers) or block id (image blocks). */
  id: string;
  label: string;
  /** File name inside cache/images, or null when the source has no image. */
  file: string | null;
  sourcePageId: string;
  kind: "cover" | "block";
  lastEditedTime: string;
  /** The image exists in Notion but could not be downloaded on the last sync. */
  failed?: boolean;
}

export interface ManifestGroup {
  id: string;
  label: string;
  items: ManifestItem[];
  /** Set when the last sync could not read this group; items are then carried over. */
  error?: string;
}

export interface Manifest {
  version: 1;
  syncedAt: string;
  mode: "notion" | "mock";
  groups: ManifestGroup[];
}

export type ScreenMode = "image" | "black";

/** Full state kept by the server and sent to DM panels. */
export interface ScreenState {
  mode: ScreenMode;
  itemId: string | null;
  zoom: number;
  focusX: number;
  focusY: number;
}

/**
 * What the players' screen receives. Deliberately carries no labels or ids,
 * only the image URL (an opaque hashed file name) and the view transform.
 */
export interface ScreenView {
  mode: ScreenMode;
  src: string | null;
  zoom: number;
  focusX: number;
  focusY: number;
}

export interface SyncStatus {
  running: boolean;
  phase: "idle" | "listing" | "downloading" | "done" | "error";
  done: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  downloaded: number;
  skipped: number;
  removed: number;
  failures: { label: string; error: string }[];
  message: string | null;
}

// Panel -> server commands.
export type PanelCommand =
  | { type: "show"; itemId: string }
  | { type: "blackout" }
  | { type: "restore" }
  | { type: "view"; zoom: number; focusX: number; focusY: number };

// Screen -> server.
export type ScreenHello = { type: "viewport"; width: number; height: number };

// Server -> panel.
export type PanelMessage =
  | { type: "state"; state: ScreenState; screens: number; aspect: number }
  | { type: "sync"; status: SyncStatus }
  | { type: "manifest" };

// Server -> screen.
export type ScreenMessage = { type: "view"; view: ScreenView };
