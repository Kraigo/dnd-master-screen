// Native "choose folder" dialog, shown on the machine the server runs on
// (the DM's laptop). A web page cannot learn a folder's real path, so the
// panel asks the server to open the dialog instead.

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out: out.trim() };
}

const PROMPT = "Choose a folder with images";

/** Returns the chosen path, null if the DM cancelled. Throws if no dialog is available. */
export async function pickFolder(): Promise<string | null> {
  if (process.platform === "darwin") {
    // `activate` brings the dialog in front of the browser window.
    const { code, out } = await run([
      "osascript",
      "-e",
      "activate",
      "-e",
      `POSIX path of (choose folder with prompt "${PROMPT}")`,
    ]);
    return code === 0 && out ? out : null;
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
