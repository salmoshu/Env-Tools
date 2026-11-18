const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const REGISTRY_QUERY = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($root in $roots) {
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $item = Get-ItemProperty $_.PSPath
    if ($item.DisplayName -match '^ZCode\\s' -and $item.InstallLocation) {
      Write-Output $item.InstallLocation.Trim()
    }
  }
}`;

function zcodeCandidatePaths(env = process.env, installLocations = []) {
  const candidates = [
    env.ZCODE_EXECUTABLE,
    ...installLocations,
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "ZCode"),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, "ZCode"),
    env.PROGRAMFILES && path.win32.join(env.PROGRAMFILES, "ZCode"),
    env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], "ZCode"),
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const value = candidate.trim().toLowerCase().endsWith(".exe")
      ? candidate.trim()
      : path.win32.join(candidate.trim(), "ZCode.exe");
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

async function installedZcodeLocations() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", REGISTRY_QUERY,
    ], { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function findZcodeExecutable() {
  const locations = await installedZcodeLocations();
  for (const candidate of zcodeCandidatePaths(process.env, locations)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function openZcode() {
  if (process.platform !== "win32") return { ok: false, error: "ZCode client launch is only supported on Windows" };
  const executable = await findZcodeExecutable();
  if (!executable) return { ok: false, error: "ZCode executable not found" };
  try {
    const child = spawn(executable, [], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { zcodeCandidatePaths, findZcodeExecutable, openZcode };
