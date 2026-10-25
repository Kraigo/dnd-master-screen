// Entry point for `bun run start` and the standalone executable.
// Starts the server (or reuses one that is already running) and opens the DM panel.

import { networkInterfaces } from "node:os";
import { openBrowser } from "./os/open-browser.ts";
import { APP_ID, startServer } from "./server.ts";
import { DATA_DIR } from "./store.ts";

const HOST = process.env.HOST || "127.0.0.1";
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
      console.log(`Already running at http://localhost:${port}/admin`);
      if (OPEN_BROWSER) openBrowser(`http://localhost:${port}/admin`);
      return;
    }
    try {
      const server = await startServer({ hostname: HOST, port });
      const base = `http://localhost:${server.port}`;
      console.log("DnD Master Screen");
      console.log(`  DM panel:        ${base}/admin`);
      console.log(`  Players' screen: ${base}/`);
      if (HOST === "0.0.0.0") {
        for (const list of Object.values(networkInterfaces())) {
          for (const a of list ?? []) {
            if (a.family === "IPv4" && !a.internal) console.log(`  On the LAN:      http://${a.address}:${server.port}/`);
          }
        }
      }
      console.log(`  Data folder:     ${DATA_DIR}`);
      console.log("\nKeep this window open during the game. Close it to stop.");
      if (OPEN_BROWSER) openBrowser(`${base}/admin`);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`Ports ${FIRST_PORT}-${FIRST_PORT + 9} are busy. Start with PORT=<number>.`);
}

await main();
