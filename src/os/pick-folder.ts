// Native "choose folder" dialog, shown on the machine the server runs on
// (the DM's laptop). A web page cannot learn a folder's real path, so the
// panel asks the server to open the dialog instead.

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out: out.trim() };
}

const PROMPT = "Choose a folder with images";

const MAC_DIALOG = `
ObjC.import("AppKit");
const previous = $.NSWorkspace.sharedWorkspace.frontmostApplication;
$.NSApplication.sharedApplication;
$.NSApp.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
$.NSApp.activateIgnoringOtherApps(true);
const panel = $.NSOpenPanel.openPanel;
panel.canChooseFiles = false;
panel.canChooseDirectories = true;
panel.allowsMultipleSelection = false;
panel.message = "${PROMPT}";
panel.prompt = "Choose";
const chosen = panel.runModal == $.NSModalResponseOK ? ObjC.unwrap(panel.URL.path) : "";
JSON.stringify({ path: chosen, previous: previous ? ObjC.unwrap(previous.bundleURL.path) : "" });
`;

/** Returns the chosen path, null if the DM cancelled. Throws if no dialog is available. */
export async function pickFolder(): Promise<string | null> {
  if (process.platform === "darwin") {
    // JXA + NSOpenPanel instead of AppleScript `choose folder`: bringing the dialog to
    // the front with AppleScript's `activate` takes about 2 s, AppKit does it at once.
    const { code, out } = await run(["osascript", "-l", "JavaScript", "-e", MAC_DIALOG]);
    let result: { path?: string; previous?: string } = {};
    try {
      result = JSON.parse(out) as typeof result;
    } catch {
      // no answer: treat as cancelled
    }
    // Focus would stay with osascript, and a browser left in the background may not
    // redraw the panel until it is clicked: bring back the app that was in front.
    if (result.previous) Bun.spawn(["open", "-a", result.previous], { stdout: "ignore", stderr: "ignore" });
    return code === 0 && result.path ? result.path : null;
  }
  if (process.platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = '${PROMPT}'`,
      "$d.ShowNewFolderButton = $false",
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }",
      "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
    ].join("; ");
    const { out } = await run(["powershell.exe", "-NoProfile", "-STA", "-Command", script]);
    return out || null;
  }
  try {
    const { code, out } = await run(["zenity", "--file-selection", "--directory", `--title=${PROMPT}`]);
    return code === 0 && out ? out : null;
  } catch {
    throw new Error("No folder dialog on this system, type the path instead");
  }
}
