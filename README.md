# dnd-master-screen

A DM screen for D&D. The laptop stays with the DM, a second monitor faces the players. The laptop shows a panel of images; click one and it appears full screen on the players' monitor. Images come from Notion (page covers and images placed on pages) and are downloaded to disk in advance, so no internet is needed at the table.

The players only ever see the image. No titles, captions or file names appear on their screen, not even in the window title ("Screen"). The app does not read or forward the text of Notion pages: only page titles (seen by the DM) and images.

## Requirements

- macOS, [Bun](https://bun.sh) 1.2 or newer (`curl -fsSL https://bun.sh/install | bash` or `brew install oven-sh/bun/bun`)
- access to the Notion workspace that holds the campaign

## Notion setup (once)

1. Open [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and click "New integration". Type: Internal, workspace: the one with the campaign. Any name will do, e.g. "DM screen". "Read content" permission is enough.
2. Copy the Internal Integration Secret (starts with `ntn_`).
3. In the project folder copy `.env.example` to `.env` and paste the token:
   ```
   NOTION_TOKEN=ntn_...
   ```
4. In Notion open the root page of your campaign, top right ••• → Connections → find your integration and connect it. Access is inherited, so the integration sees every subpage and database inside (characters, locations, items, the city page).

### Where images come from

Everything is described in `panel.config.json`; each group becomes a tab in the panel:

| Tab | Source |
|---|---|
| Characters, Locations, Items | one image per page of the matching database: the page cover, or, if the page has no cover, the first image placed directly on the page. Label = the `Name` property |
| Maps | every image placed directly on the city page (the first one is the map), label = the image caption in Notion or "<page title> N"; plus the cover of the campaign root page labelled "Cover" |

To give a page an image, either put an image at the top level of the page body (`/image`), or set a cover: hover the title, "Add cover", then "Change cover" → Upload or Link. The cover wins if both exist. Pages with neither are shown greyed out as "no image" and cannot be sent to the screen.

Only top-level blocks are scanned. An image inside a column, toggle or callout is not found; move it to the top level of the page.

## Running

```sh
bun install
bun run sync     # download all images from Notion into cache/
bun run start
```

| Address | What |
|---|---|
| `http://localhost:4321/` | players' screen |
| `http://localhost:4321/admin` | DM panel |

Open `/admin` on the laptop. The "Open players' screen" button opens the players' screen in a separate window.

### Players' screen on an external monitor

1. Connect the monitor. In System Settings → Displays choose "Extend" (not "Mirror"), otherwise the players see the panel too.
2. Click "Open players' screen" and drag that window to the external monitor.
3. Go full screen: double-click the image, Ctrl+Cmd+F, or the green window button. The cursor hides itself after a couple of seconds.
4. The panel stays on the laptop. The "On screen now" box shows exactly what the players see.

To open the players' screen on another device (a TV with a browser, a second laptop), start the server with `HOST=0.0.0.0 bun run start`. The console prints an address like `http://192.168.1.20:4321/`. Note that anyone on the same Wi-Fi can then open `/admin` too.

### Controls

- click an image: show it to the players
- "Black out", `B` or `Esc`: black screen. `Esc` works even from the search box
- "Show again" or `R`: bring back the last image
- `←` `→`: neighbouring image in the current tab, `1`–`9`: image by number
- zoom for maps: the 1×–4× slider or a click on the preview. A click centres the players' screen on that point (at 1× it also zooms to 2×). `+` `−` change zoom, `0` and "Reset" reset
- `/`: search by title

Letter shortcuts also work with a non-Latin (e.g. Russian) keyboard layout.

## Before the game: sync

During play the server only serves images from `cache/` and never contacts Notion. So: at home, with internet, run `bun run sync` or press "Sync" in the panel. After that Wi-Fi can be off.

A repeated sync downloads only what changed (by the last edit time of the page or block) and deletes image files that are no longer in Notion. If one image fails, the rest are saved and that one keeps its previous version, if there was one. If Notion is unreachable altogether, the cache is left untouched.

## Demo mode without Notion

```sh
MOCK=1 bun run sync
MOCK=1 bun run start
```

Images are taken from the `fixtures/` folder instead of Notion (create it and drop any jpg/png there). Another folder can be set with `MOCK_DIR=/path/to/images`. If the folder is missing or empty, abstract placeholders are drawn. Titles in demo mode are made up. Handy for checking the monitor and controls without touching Notion.

## Troubleshooting

- **401** / "invalid token": the token in `.env` is wrong or the integration was deleted. Copy the token again.
- **404** / "no access": the integration is not connected to the campaign root page (setup step 4). Or a database/page lives outside the root page; connect the integration to it too.
- **Image failed, "HTTP 403" or "HTTP 400"**: Notion file links live about an hour. Just run the sync again.
- **Panel says "No images yet"**: sync has not run yet. Press "Sync".
- **Most items show "no image"**: those pages have no cover and no top-level image (see "Where images come from").
- **A tab is marked "error"**: that tab could not be read; the panel keeps the images from the previous sync. Hover for the reason, or see the "Failed downloads" list under the sync button.
- **Players' screen does not update**: make sure the server is running. The screen reconnects by itself and keeps the last image until then.
- **Port in use**: `PORT=4322 bun run start`.

## Development

```sh
bun run dev        # server with reload on changes
bun run typecheck  # type check
```

Code: `src/server.ts` (HTTP, WebSocket, screen state), `src/sync/` (sync: `notion.ts`, `mock.ts`), `src/panel/` and `src/screen/` (pages, bundled by Bun's built-in bundler). Cache: `cache/manifest.json` and `cache/images/`.
