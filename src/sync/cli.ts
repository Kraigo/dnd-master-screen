// `bun run sync` — download all images from Notion (or fixtures with MOCK=1) into cache/.
import { runSync } from "./index.ts";

const status = await runSync();
console.log(
  `\nDownloaded: ${status.downloaded}, unchanged: ${status.skipped}, stale files removed: ${status.removed}, errors: ${status.failures.length}`,
);
if (status.phase === "error") process.exit(1);
if (status.failures.length > 0) process.exit(2);
