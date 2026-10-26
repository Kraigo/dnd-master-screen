// Types shared by the server, the sync code and both browser pages.

export interface ManifestItem {
  /** Stable id: Notion page id (covers), block id (image blocks) or hash of the relative path (folders). */
  id: string;
  label: string;
  /** Opaque file name served at /images/<file>, or null when the source has no image. */
  file: string | null;
  /** Notion page the image came from; the relative subfolder for folder projects. */
  sourcePageId: string;
  kind: "cover" | "block" | "file" | "note";
  lastEditedTime: string;
  /** The image exists in Notion but could not be downloaded on the last sync. */
  failed?: boolean;
  /** Obsidian: a note embeds an image that is not on disk (offloaded = iCloud has not downloaded it). */
  missing?: "offloaded" | "not-found";
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
  mode: "notion" | "folder" | "obsidian";
  groups: ManifestGroup[];
}

/** A game: either a linked folder of images or a Notion campaign page. */
export type Project =
  | { id: string; name: string; type: "folder"; path: string }
  /** An Obsidian vault (or a folder in one): images grouped by the notes that embed them. */
  | { id: string; name: string; type: "obsidian"; path: string }
  | { id: string; name: string; type: "notion"; rootPageId: string };

/** Projects whose images are read straight from a folder on disk. */
export type LocalProject = Extract<Project, { path: string }>;

export function isLocalProject(p: Project | null | undefined): p is LocalProject {
  return p?.type === "folder" || p?.type === "obsidian";
}

/** What the DM panel gets from GET /api/state. The Notion token itself is never sent. */
export interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  manifest: Manifest | null;
  /** Folder projects: why the folder could not be read (missing, no access). */
  folderError: string | null;
  sync: SyncStatus;
  notion: { tokenSet: boolean; workspace: string | null };
  /** Access from other devices on the network. */
  lan: {
    enabled: boolean;
    /** Addresses other devices can use, e.g. "http://192.168.1.20:4321". */
    addresses: string[];
  };
  /** The request comes from the computer running the app (may change LAN mode, quit). */
  local: boolean;
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
  /** Project the status belongs to (null before the first sync). */
  projectId: string | null;
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
