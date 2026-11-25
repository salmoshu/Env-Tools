import { useEffect, useRef, useState } from "react";
import { invoke } from "../adapter";
import { listen, type UnlistenFn } from "../adapter";
import { formatBytes, isWindows } from "../format";
import ConfirmClean from "../components/ConfirmClean";
import Treemap from "../components/Treemap";
import type { CleanOutcome, DeepEntry, Verdict } from "../types";
import { dt, useLang } from "../i18n";

const KIND_LABEL: Record<DeepEntry["kind"], string> = {
  system: "System",
  applications: "Apps",
  user_data: "Your files",
  app_data: "App data",
  dev: "Dev / config",
  other: "Other",
};

const ROOT = "__root__";

function verdictLabel(v: Verdict): string {
  if (v.basis === "unknown") return dt("Unknown — look inside");
  if (v.safety === "safe") return dt("Safe to remove");
  if (v.safety === "caution") return dt("Remove with care");
  return dt("Review first");
}

const BASIS_HINT: Record<Verdict["basis"], string> = {
  known: "Env-Tools knows this location.",
  detected: "Judged from what the folder contains.",
  unknown: "Env-Tools does not recognise this folder.",
};

export default function DeepClean({ onRecovered }: { onRecovered: (bytes: number) => void }) {
  useLang();
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const [entries, setEntries] = useState<DeepEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<DeepEntry | null>(null);
  const [mode, setMode] = useState<"map" | "list">("map");
  const cache = useRef(new Map<string, DeepEntry[]>());
  const activeToken = useRef("");

  const currentPath = crumbs.length ? crumbs[crumbs.length - 1] : null;

  const scan = async (path: string | null, force = false) => {
    const key = path ?? ROOT;
    if (!force && cache.current.has(key)) {
      // Leaving a level that is still being measured: stop listening to it,
      // or its rows would land in this list and "Measuring…" would stay up.
      activeToken.current = "";
      setScanning(false);
      setEntries(cache.current.get(key)!);
      return;
    }
    const token = `${key}:${Math.random()}`;
    activeToken.current = token;
    setEntries([]);
    setScanning(true);
    setError(null);
    try {
      const result = await invoke<DeepEntry[]>("deep_scan", { path, token });
      if (activeToken.current === token) {
        cache.current.set(key, result);
        setEntries(result);
      }
    } catch (e) {
      if (activeToken.current === token) setError(String(e));
    } finally {
      if (activeToken.current === token) setScanning(false);
    }
  };

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ token: string; entry: DeepEntry }>("deep-entry", (event) => {
      if (event.payload.token !== activeToken.current) return;
      setEntries((prev) =>
        [...prev.filter((p) => p.path !== event.payload.entry.path), event.payload.entry].sort(
          (a, b) => b.size_bytes - a.size_bytes
        )
      );
    }).then((u) => (unlisten = u));
    scan(null);
    return () => unlisten?.();
  }, []);

  const navigate = (entry: DeepEntry) => {
    if (!entry.is_dir) return;
    const next = [...crumbs, entry.path];
    setCrumbs(next);
    scan(entry.path);
  };

  const jumpTo = (index: number) => {
    const next = crumbs.slice(0, index + 1);
    setCrumbs(next);
    scan(next.length ? next[next.length - 1] : null);
  };

  const clean = async (entry: DeepEntry) => {
    setConfirming(null);
    try {
      const outcome = await invoke<CleanOutcome>("clean_paths", { paths: [entry.path], source: "Deep clean" });
      if (outcome.errors.length) setError(outcome.errors.join("; "));
      onRecovered(outcome.freed_bytes);
      const key = currentPath ?? ROOT;
      const updated = entries.filter((e) => e.path !== entry.path);
      cache.current.set(key, updated);
      setEntries(updated);
    } catch (e) {
      setError(String(e));
    }
  };

  const reveal = (path: string) =>
    invoke("reveal_path", { path }).catch((e) => setError(String(e)));

  // A folder Env-Tools could not read measures less than it holds, maybe 0 B, so
  // the map draws it small or not at all: name it rather than let it vanish.
  const unreadable = entries.filter((e) => e.unreadable > 0);
  const maxSize = entries.length ? Math.max(...entries.map((e) => e.size_bytes)) : 1;
  const totalSize = entries.reduce((a, e) => a + e.size_bytes, 0);

  return (
    <>
      {confirming && (
        <ConfirmClean
          request={{
            kind: confirming.kind === "user_data" ? "userfile" : "cache",
            title: dt("Move {name} to the {bin}?", { name: confirming.name, bin: dt(isWindows ? "Recycle Bin" : "Trash") }),
            items: [confirming.path],
            bytes: confirming.size_bytes,
            risky: confirming.verdict ? confirming.verdict.safety !== "safe" : true,
          }}
          onConfirm={() => clean(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}

      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Deep clean")}</h2>
          <p className="view-sub">{dt("Full-disk analysis — see what every folder actually holds")}</p>
        </div>
        <button className="btn" onClick={() => scan(currentPath, true)} disabled={scanning}>
          {dt(scanning ? "Scanning…" : "Rescan")}
        </button>
      </div>

      {error && (
        <div className="banner-error">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      <div className="crumbs">
        <button className="crumb" onClick={() => jumpTo(-1)}>{dt("This computer")}</button>
        {crumbs.map((c, i) => (
          <span key={c}>
            <span className="crumb-sep">/</span>
            <button className="crumb" onClick={() => jumpTo(i)}>
              {c.split("/").filter(Boolean).pop() ?? c}
            </button>
          </span>
        ))}
        <span className="crumb-total">
          {dt(scanning ? "Measuring…" : "{size} in {n} items", { size: formatBytes(totalSize), n: entries.filter((e) => !e.is_virtual).length })}
        </span>
      </div>

      <div className="filter-row">
        <div className="filter-tabs">
          <button
            className={`filter-tab ${mode === "map" ? "is-active" : ""}`}
            aria-pressed={mode === "map"}
            onClick={() => setMode("map")}
          >
            {dt("Map")}
          </button>
          <button
            className={`filter-tab ${mode === "list" ? "is-active" : ""}`}
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            {dt("List")}
          </button>
        </div>
        {mode === "list" && (
          <div className="legend" style={{ margin: 0 }}>
            {[
              ["kindfill-user_data", "Your files"],
              ["kindfill-applications", "Apps"],
              ["kindfill-app_data", "App data"],
              ["kindfill-dev", "Dev / config"],
              ["kindfill-system", "System"],
            ].map(([cls, label]) => (
              <span key={label} className="legend-item">
                <i className={`dot ${cls}`} />
                {dt(label)}
              </span>
            ))}
          </div>
        )}
      </div>

      {mode === "map" && entries.length > 0 && (
        <>
          {unreadable.length > 0 && !scanning && (
            <div className="banner-info">
              {dt(unreadable.length === 1 ? "Env-Tools could not read everything in {n} folder, so it is smaller on the map than on disk, or missing from it: {names}." : "Env-Tools could not read everything in {n} folders, so they are smaller on the map than on disk, or missing from it: {names}.", { n: unreadable.length, names: unreadable.map((e) => e.name).join(", ") })}{dt(" ")}
              {dt(isWindows ? "Run Env-Tools as an administrator to measure them." : "Grant Full Disk Access in System Settings → Privacy and Security to measure them.")}
            </div>
          )}
          {scanning && (
            <div className="map-scanning">
              <div className="spinner sm" />
              <span className="view-sub">{dt("Measuring — blocks appear as each folder finishes…")}</span>
            </div>
          )}
          <Treemap entries={entries} onOpen={navigate} />
          <p className="footnote">{dt("Each block is a folder, sized by what it holds and coloured by how safe it is to remove, the same rating the List shows. Click a block (or Tab to it and press Enter) to go inside. Hatched grey stands for items too small to draw — switch to List to see everything and to clean.")}</p>
        </>
      )}

      {mode === "list" && (
      <div className="deep-list">
        {entries.map((e) => (
          <div key={e.path} className="deep-item">
          <div className={`deep-row ${e.protected ? "is-protected" : ""}`}>
            <button
              className="deep-name"
              onClick={() => navigate(e)}
              disabled={!e.is_dir}
              title={dt(e.hint)}
            >
              <span className="deep-icon">{e.is_dir ? dt("▸") : dt("·")}</span>
              {e.name}
            </button>
            {e.verdict ? (
              <span
                className={`badge safety-${e.verdict.basis === "unknown" ? "caution" : e.verdict.safety}`}
                title={dt("{p0} {p1}", { p0: dt(BASIS_HINT[e.verdict.basis]), p1: e.verdict.reasons.map((r) => dt(r.text)).join(" ") })}
              >
                {dt(verdictLabel(e.verdict))}
              </span>
            ) : (
              <span className={`badge kind-${e.kind}`}>{dt(KIND_LABEL[e.kind])}</span>
            )}
            {e.protected && !e.is_virtual && <span className="badge safety-risky">{dt("Protected")}</span>}
            {e.is_virtual && (
              <span className="badge stale" title={dt(e.hint)}>{dt("Needs admin to see")}</span>
            )}
            {e.unreadable > 0 && (
              <span
                className="badge stale"
                title={dt(e.unreadable === 1 ? "{n} item inside could not be read, so the size shown is less than the folder holds." : "{n} items inside could not be read, so the size shown is less than the folder holds.", { n: e.unreadable.toLocaleString() })}
              >
                {dt("Partly unreadable")}
              </span>
            )}
            {e.online_only_bytes >= 1e8 && (
              <span
                className="badge cat-dev_cache"
                title={dt("Cloud files (OneDrive, iCloud) that are listed here but stored only online. They use no space on this disk and are not in the size shown.")}
              >
                {dt("+{size} online-only", { size: formatBytes(e.online_only_bytes) })}
              </span>
            )}
            {e.shared_bytes >= 1e8 && (
              <span
                className="badge stale"
                title={dt("Files here that are hard links to files already counted in another folder, so they take no extra space and are not in the size shown. Removing only this folder would not free them.")}
              >
                {dt("+{size} shared", { size: formatBytes(e.shared_bytes) })}
              </span>
            )}
            <div className="deep-bar">
              <div
                className={`deep-fill kindfill-${e.kind}`}
                style={{ width: `${Math.max(1, (e.size_bytes / maxSize) * 100)}%` }}
              />
            </div>
            <span className="deep-size">{formatBytes(e.size_bytes)}</span>
            <span className="deep-files">
              {e.is_virtual ? dt("") : dt("{n} files", { n: e.file_count.toLocaleString() })}
            </span>
            <div className="finding-actions">
              {!e.is_virtual && (
                <button className="btn-ghost sm" onClick={() => reveal(e.path)}>{dt("Show")}</button>
              )}
              {!e.protected && (e.verdict?.clean_here ?? true) && (
                <button className="btn-clean sm" onClick={() => setConfirming(e)}>{dt("Clean")}</button>
              )}
            </div>
          </div>
          {e.verdict && (
            <ul className="safety-reasons deep-why">
              {e.verdict.what && <li className="deep-what">{dt(e.verdict.what)}</li>}
              {e.verdict.reasons.map((r) => (
                <li key={r.text} className={`reason-${r.level}`}>
                  <span className="reason-mark" aria-hidden>
                    {r.level === "ok" ? dt("✓") : r.level === "warn" ? dt("!") : dt("✕")}
                  </span>
                  {dt(r.text)}
                </li>
              ))}
            </ul>
          )}
          </div>
        ))}
        {scanning && (
          <div className="deep-row scanning-row">
            <div className="spinner sm" />
            <span className="view-sub">{dt("Measuring folders — large ones appear as they finish…")}</span>
          </div>
        )}
      </div>
      )}

      <p className="footnote">
        {dt("System locations are protected and can never be cleaned from Env-Tools.")}{dt(" ")}
        {dt(isWindows ? "If some folders show 0 B, they need administrator rights to read — run Env-Tools as an administrator to measure them." : "If some folders show 0 B, grant Full Disk Access in System Settings → Privacy & Security.")}
      </p>
    </>
  );
}
