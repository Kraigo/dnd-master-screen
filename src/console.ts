// Single-key commands in the console window the app runs in, for people who
// prefer it (or cannot reach the browser): other devices, password, folders,
// projects, clearing data, quitting. Only active when stdin is a terminal.

import { homedir } from "node:os";
import { openBrowser } from "./os/open-browser.ts";
import { pickFolder } from "./os/pick-folder.ts";
import {
  addProject,
  clearAllData,
  logLan,
  openProject,
  otherDevicesState,
  projectList,
  quitApp,
  rebind,
  setOtherDevices,
} from "./server.ts";

const HELP = `
Commands (press a key):
  O  open the master panel           N  other devices on / off
  P  set the master password         F  add a folder project
  L  list and switch projects        C  clear all app data
  H  show this help                  Q  quit`;

/** Keys at the same position on Cyrillic layouts, so commands work without switching the layout. */
const LAYOUT: Record<string, string> = {
  "\u0449": "o", // O
  "\u0442": "n", // N
  "\u0437": "p", // P
  "\u0430": "f", // F
  "\u0434": "l", // L
  "\u0441": "c", // C
  "\u0440": "h", // H
  "\u0439": "q", // Q
};

const write = (s: string) => process.stdout.write(s);
const say = (s = ""): void => {
  write(`${s}\n`);
};

/** Raw keyboard input: every chunk of typed (or pasted) characters, in order. */
class Keys {
  private buffer = "";
  private waiting: ((chunk: string) => void) | null = null;

  constructor() {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (data: string) => {
      this.buffer += data;
      this.flush();
    });
    process.stdin.resume();
  }

  private flush(): void {
    if (!this.buffer || !this.waiting) return;
    const resolve = this.waiting;
    const chunk = this.buffer;
    this.waiting = null;
    this.buffer = "";
    resolve(chunk);
  }

  next(): Promise<string> {
    return new Promise((resolve) => {
      this.waiting = resolve;
      this.flush();
    });
  }

  /** Read a line. `mask` hides the characters. Returns null on Esc or Ctrl+C. */
  async line(question: string, mask = false): Promise<string | null> {
    write(question);
    let value = "";
    for (;;) {
      const chunk = await this.next();
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i]!;
        if (ch === "\r" || ch === "\n") {
          say();
          return value;
        }
        if (ch === "\u0003" || (ch === "\u001b" && chunk.length === 1)) {
          say(" (cancelled)");
          return null;
        }
        if (ch === "\u001b") break; // arrow keys and other escape sequences: ignore
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = [...value].slice(0, -1).join("");
            write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        write(mask ? "*" : ch);
      }
    }
  }
}

/** A path typed, pasted or dragged into the terminal: drop quotes and shell escapes, expand ~. */
export function cleanPath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
  else if (process.platform !== "win32") p = p.replace(/\\(.)/g, "$1");
  if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
  return p;
}

async function askNewPassword(keys: Keys): Promise<string | null> {
  const first = await keys.line("New master password (at least 4 characters): ", true);
  if (!first) return null;
  if (first.length < 4) {
    say("Too short. Nothing changed.");
    return null;
  }
  const second = await keys.line("Repeat it: ", true);
  if (second === null) return null;
  if (first !== second) {
    say("The passwords do not match. Nothing changed.");
    return null;
  }
  return first;
}

async function toggleOtherDevices(keys: Keys): Promise<void> {
  const { enabled, passwordSet } = otherDevicesState();
  if (enabled) {
    await setOtherDevices(false);
    await rebind();
    return;
  }
  let password = "";
  if (!passwordSet) {
    say("Other devices need a master password to open the master panel.");
    password = (await askNewPassword(keys)) ?? "";
    if (!password) return;
  }
  const error = await setOtherDevices(true, password);
  if (error) return say(error);
  await rebind();
  if (!password) say("Using your current master password (P to change it).");
}

async function setPassword(keys: Keys): Promise<void> {
  const password = await askNewPassword(keys);
  if (!password) return;
  const error = await setOtherDevices(otherDevicesState().enabled, password);
  say(error ?? "Master password saved. Other devices have to enter it again.");
}

async function addFolder(keys: Keys): Promise<void> {
  const raw = await keys.line("Folder path (drag the folder here, or press Enter to choose it in a dialog): ");
  if (raw === null) return;
  let path = cleanPath(raw);
  if (!path) {
    try {
      path = (await pickFolder()) ?? "";
    } catch (e) {
      return say((e as Error).message);
    }
    if (!path) return say("No folder chosen.");
  }
  const result = await addProject({ type: "folder", path });
  say(typeof result === "string" ? result : `Added and opened "${result.name}".`);
}

async function listProjects(keys: Keys): Promise<void> {
  const { projects, activeId } = projectList();
  if (!projects.length) return say("No projects yet. Press F to add a folder.");
  projects.forEach((p, i) => {
    const where = p.type === "folder" ? p.path : "Notion";
    say(`  ${p.id === activeId ? "*" : " "} ${i + 1}. ${p.name}  (${where})`);
  });
  const answer = await keys.line("Number to open (Enter to keep the current one): ");
  if (!answer) return;
  const p = projects[Number(answer) - 1];
  if (!p) return say("No project with that number.");
  await openProject(p.id);
  say(`Opened "${p.name}".`);
}

async function clearData(keys: Keys): Promise<void> {
  say("This forgets all projects, the Notion token, the master password and downloaded Notion images.");
  say("Your own image folders are not touched.");
  const answer = await keys.line('Type "clear" to confirm: ');
  if (answer?.trim().toLowerCase() !== "clear") return say("Nothing changed.");
  const error = await clearAllData();
  say(error ?? "All app data cleared.");
}

export function startConsole(masterUrl: string): void {
  if (!process.stdin.isTTY) return;
  const keys = new Keys();
  say(HELP);

  void (async () => {
    for (;;) {
      const chunk = await keys.next();
      if (chunk.startsWith("\u001b")) continue; // arrows, function keys
      const ch = chunk[0]!;
      if (ch === "\u0003" || ch === "\u0004") quitApp("Stopped."); // Ctrl+C, Ctrl+D
      const key = LAYOUT[ch.toLowerCase()] ?? ch.toLowerCase();
      say();
      try {
        switch (key) {
          case "o":
            openBrowser(masterUrl);
            say(`Opening ${masterUrl}`);
            break;
          case "n":
            await toggleOtherDevices(keys);
            break;
          case "p":
            await setPassword(keys);
            break;
          case "f":
            await addFolder(keys);
            break;
          case "l":
            await listProjects(keys);
            break;
          case "c":
            await clearData(keys);
            break;
          case "q":
            quitApp("Stopped.");
            break;
          case "h":
          case "?":
            say(HELP);
            logLan();
            break;
          default:
            say("Unknown key. Press H for the list of commands.");
        }
      } catch (e) {
        say(`Error: ${(e as Error).message}`);
      }
    }
  })();
}
