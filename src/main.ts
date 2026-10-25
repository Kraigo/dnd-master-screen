// Entry point for `bun run start` and the standalone executable.
// Starts the server (or reuses one that is already running) and opens the DM panel.

import { openBrowser } from "./os/open-browser.ts";
import { APP_ID, logLan, startServer } from "./server.ts";
import { DATA_DIR } from "./store.ts";

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

async function main(): Promise<void> {
  for (let port = FIRST_PORT; port < FIRST_PORT + 10; port++) {
    if (await runningInstance(port)) {
      console.log(`Already running at http://localhost:${port}/master`);
      if (OPEN_BROWSER) openBrowser(`http://localhost:${port}/master`);
      return;
    }
    try {
      const server = await startServer(port);
      console.log("DnD Master Screen");
      const base = `http://localhost:${server.port}`;
      console.log(`  Master panel:    ${base}/master`);
      console.log(`  Players' screen: ${base}/`);
      logLan();
      console.log(`  Data folder:     ${DATA_DIR}`);
      console.log("\nKeep this window open during the game. To stop: close it, or Quit in the master panel.");
      if (OPEN_BROWSER) openBrowser(`${base}/master`);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`Ports ${FIRST_PORT}-${FIRST_PORT + 9} are busy. Start with PORT=<number>.`);
}

await main();
