# dnd-master-screen

A DM screen for tabletop games. The laptop stays with the DM, a second monitor faces the players. The master panel shows your images; click one and it appears full screen on the players' monitor.

Images come from **projects**, one per game:

- **Folder**: any folder on your computer. Subfolders become tabs, file names become captions. Images are not copied; add a file to the folder and it shows up in the panel.
- **Notion**: a campaign page in Notion. Images are downloaded in advance, so no internet is needed at the table.

The players only ever see the image: no titles, captions or file names, not even in the window title.

## Install

Download the file for your system and put it anywhere (e.g. Applications or Desktop):

- macOS (Apple Silicon): `dnd-master-screen-mac`
- Windows: `dnd-master-screen.exe`

Run it. A console window opens and the master panel opens in your browser at `http://localhost:4321/master`. Keep the console window open during the game. To stop the app, close that window, press Q (or Ctrl+C) in it, or use **Settings → Quit app** in the master panel. Running the app again while it is already running just opens the panel.

### Console commands

The console window also takes single-key commands (they work with a Cyrillic keyboard layout too):

| Key | Action |
|---|---|
| O | open the master panel in the browser |
| N | other devices on / off (asks for a master password the first time) |
| P | set or change the master password |
| F | add a folder project: drag the folder into the window and press Enter, or press Enter to pick it in a dialog |
| L | list projects and switch to one by number |
| C | clear all app data: projects, Notion token, master password, downloaded Notion images (asks to type `clear`; your image folders are not touched) |
| H | show the commands |
| Q | quit (Ctrl+C works too) |

The files are not signed, so the system warns on first launch:

- **macOS**: right-click the file → Open → Open. If macOS says it is damaged or cannot be checked, run once in Terminal: `xattr -d com.apple.quarantine ~/Downloads/dnd-master-screen-mac` (use the real path).
- **Windows**: SmartScreen "Windows protected your PC" → More info → Run anyway.

Your projects and settings live in the app data folder (shown in the console), so replacing the app with a newer version keeps them:

- macOS: `~/Library/Application Support/DnD Master Screen/`
- Windows: `%APPDATA%\DnD Master Screen\`

## Projects

Open **Settings** at the top of the panel. The dropdown next to it switches between projects; switching blacks out the players' screen.

### Folder project

"Choose folder…" opens the system folder dialog (or type the path). Layout:

```
My campaign/
  Overview.png          -> tab "All"
  Characters/           -> tab "Characters"
    Innkeeper.jpg
    NPC/Guard.png       (deeper folders count towards their top-level folder)
  Maps/                 -> tab "Maps"
    City.webp
```

Supported: jpg, png, webp, gif, avif, svg. Files and folders starting with a dot are ignored. Sorting is natural ("Hero 2" before "Hero 10"). The list updates by itself when files change; "Rescan" forces it. Removing a folder project never touches the folder.

### Notion project

1. Open [notion.so/profile/integrations](https://www.notion.so/profile/integrations), create an Internal integration in the workspace of the campaign, with "Read content".
2. Copy its secret (starts with `ntn_`) and paste it in Settings → Notion token. The app checks it and shows the workspace name.
3. In Notion open the campaign root page, ••• → Connections → add the integration. Access is inherited by every subpage and database inside.
4. In Settings → "Add a Notion campaign", paste the link to that page. The first sync starts right away.

What becomes a tab:

| Tab | Source |
|---|---|
| one per database on the page (also inside columns) | one image per entry: the page cover, or, if there is no cover, the first image placed directly on the entry's page. Caption = entry title |
| Pages | the root page cover ("Cover"), images placed directly on the root page and on its subpages. Caption = image caption in Notion or "<page title> N" |

Only top-level blocks are scanned: an image inside a toggle or callout is not found. Linked views of databases that live elsewhere are skipped. Entries with no image are shown greyed out as "no image".

The app reads only page titles, covers and image blocks; page text is dropped right away and never stored. The token is stored in `settings.json` in the app data folder, readable only by your user.

**Before the game**: press "Sync" at home. It downloads only what changed and removes images that are gone from Notion. If one image fails, the others are saved and that one keeps its previous version. If Notion is unreachable, the cache is left untouched.

## At the table

1. Connect the monitor. macOS: System Settings → Displays → "Extend" (not "Mirror"). Windows: Win+P → Extend.
2. In the panel click "Open players' screen" and drag that window to the external monitor.
3. Go full screen: double-click the image (or Ctrl+Cmd+F on macOS, F11 on Windows). The cursor hides itself.
4. The "On screen now" box in the panel shows exactly what the players see.

Controls:

- click an image: show it to the players
- "Black out", `B` or `Esc`: black screen. `Esc` works even from the search box
- "Show again" or `R`: bring back the last image
- `←` `→`: neighbouring image in the current tab, `1`–`9`: image by number
- zoom for maps: the 1×–4× slider or a click on the preview (centres the players' screen on that point; at 1× it also zooms to 2×). `+` `−` change zoom, `0` and "Reset" reset
- `/`: search by title

Letter shortcuts also work with a non-Latin (e.g. Ukrainian) keyboard layout.

### Players' screen on another device

By default only the computer running the app can open it. To use a TV browser, another laptop or a tablet on the same Wi-Fi: **Settings → Other devices**, set a master password and press "Allow other devices". The panel then lists the addresses, e.g.:

- players' screen: `http://192.168.1.20:4321/` (no password)
- master panel: `http://192.168.1.20:4321/master` (asks for the master password)

The computer running the app never needs the password. Turning other devices on or off and quitting the app are possible only on that computer. Changing the password or pressing "Only this computer" logs every other device out; after 5 wrong passwords a device must wait a minute. The setting is remembered across restarts.

The first time, the system may ask whether the app may accept incoming network connections (macOS) or show a Windows Defender Firewall prompt: allow it for private networks.

## Troubleshooting

- **401 / "invalid token"**: the token is wrong or the integration was deleted. Paste it again in Settings.
- **404 / "no access"**: the integration is not connected to the campaign page (step 3), or a database lives outside it.
- **Image failed, "HTTP 403" or "HTTP 400"**: Notion file links live about an hour. Sync again.
- **"Folder not available"**: the folder was moved, renamed or is on a disconnected drive. Remove the project and add the folder again.
- **Players' screen does not update**: make sure the app is still running. The screen reconnects by itself and keeps the last image until then.
- **Other devices cannot connect**: check that both are on the same Wi-Fi, the firewall prompt was allowed, and "Other devices" is on. Guest networks often block devices from seeing each other.
- **Port in use**: the app tries the next ports (4322, 4323…) by itself; the console shows which one it took.

## Development

Requires [Bun](https://bun.sh) 1.2+.

```sh
bun install
bun run dev        # http://localhost:4321/master, data in ./.data, reload on changes
bun run typecheck
bun run start      # production mode, data in the app data folder, opens the browser
bun run build      # dist/dnd-master-screen-mac and dist/dnd-master-screen.exe
```

`build:mac` re-signs the binary ad hoc (`codesign --sign -`): without it recent macOS versions kill the compiled binary on launch. Build it on a Mac.

Environment variables: `PORT` (default 4321), `DATA_DIR` (app data folder), `NO_BROWSER=1` (do not open the browser).

Code:

- `src/main.ts`: entry point, port selection, opens the browser
- `src/console.ts`: single-key console commands
- `src/server.ts`: HTTP API, WebSocket, screen state, active project, other-devices mode and master password
- `src/store.ts`: app data folder, `settings.json`, `projects.json`
- `src/projects/folder.ts`: folder scanning and watching
- `src/sync/`: Notion discovery (`notion.ts`) and incremental download (`index.ts`)
- `src/os/`: native folder dialog, opening the browser
- `src/panel/`, `src/screen/`: the two pages, bundled by Bun
