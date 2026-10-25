// Entry point for `bun run start` and the standalone executable.
// Starts the server (or reuses one that is already running) and opens the DM panel.

import { startConsole } from "./console.ts";
import { openBrowser } from "./os/open-browser.ts";
import { APP_ID, logLan, startServer } from "./server.ts";
import { DATA_DIR } from "./store.ts";
import { version } from "../package.json";

const FIRST_PORT = Number(process.env.PORT) || 4321;
const OPEN_BROWSER = !process.env.NO_BROWSER;

async function runningInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return ((await res.json()) as { app?: string }).app === APP_ID;
  } catch {
    return false;
  }
}

/**
 * Is anything else listening on this port on 127.0.0.1? Needed because binding
 * 0.0.0.0 (other-devices mode) can succeed next to a program that already holds
 * 127.0.0.1 on the same port, and then "localhost" would reach that program.
 */
async function portTaken(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  for (let port = FIRST_PORT; port < FIRST_PORT + 10; port++) {
    if (await runningInstance(port)) {
      console.log(`Already running at http://localhost:${port}/master`);
      if (OPEN_BROWSER) openBrowser(`http://localhost:${port}/master`);
      return;
    }
    if (await portTaken(port)) {
      console.log(`Port ${port} is used by another program, trying ${port + 1}.`);
      continue;
    }
    try {
      const server = await startServer(port);
      const base = `http://localhost:${server.port}`;
      console.log(`DnD Master Screen ${version}\n`);
      console.log("On this computer (no password needed, opens automatically):");
      console.log(`  Master panel:    ${base}/master`);
      console.log(`  Players' screen: ${base}/`);
      logLan();
      console.log(`\nData folder: ${DATA_DIR}`);
      console.log("Keep this window open during the game. To stop: close it, press Q, or Quit in the master panel.");
      if (OPEN_BROWSER) openBrowser(`${base}/master`);
      startConsole(`${base}/master`);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`Ports ${FIRST_PORT}-${FIRST_PORT + 9} are busy. Start with PORT=<number>.`);
}

await main();
