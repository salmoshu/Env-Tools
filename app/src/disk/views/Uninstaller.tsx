import { useEffect, useState } from "react";
import { invoke } from "../adapter";
import { formatBytes } from "../format";
import type { AppInfo, CleanOutcome, LeftoverEntry } from "../types";
import { dt, useLang } from "../i18n";

export default function Uninstaller({ onRecovered }: { onRecovered: (bytes: number) => void }) {
  useLang();
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AppInfo | null>(null);
  const [leftovers, setLeftovers] = useState<LeftoverEntry[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      setApps(await invoke<AppInfo[]>("list_apps"));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan();
  }, []);

  const select = async (app: AppInfo) => {
    setSelected(app);
    setLeftovers(null);
    setConfirming(false);
    try {
      const found = await invoke<LeftoverEntry[]>("app_leftovers", {
        bundleId: app.bundle_id,
        name: app.name,
      });
      setLeftovers(found);
      setChecked(new Set([app.path, ...found.filter((l) => l.confident).map((l) => l.path)]));
    } catch (e) {
      setError(String(e));
    }
  };

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const uninstall = async () => {
    if (!selected) return;
    setWorking(true);
    setConfirming(false);
    try {
      // Windows programs must run their own uninstaller so they can
      // unregister properly; leftovers are swept afterwards.
      if (selected.uninstall_command) {
        await invoke("run_uninstaller", { command: selected.uninstall_command });
        const leftovers = [...checked].filter((p) => p !== selected.path);
        if (leftovers.length) {
          const swept = await invoke<CleanOutcome>("clean_paths", { paths: leftovers, source: "Uninstaller" });
          if (swept.errors.length) setError(swept.errors.join("; "));
          onRecovered(swept.freed_bytes);
        }
        setSelected(null);
        setLeftovers(null);
        return;
      }
      const outcome = await invoke<CleanOutcome>("clean_paths", { paths: [...checked], source: "Uninstaller" });
      if (outcome.errors.length) setError(outcome.errors.join("; "));
      onRecovered(outcome.freed_bytes);
      setApps((a) => (a ? a.filter((x) => x.path !== selected.path) : a));
      setSelected(null);
      setLeftovers(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  const selectedTotal = selected
    ? (checked.has(selected.path) ? selected.size_bytes : 0) +
      (leftovers ?? []).filter((l) => checked.has(l.path)).reduce((a, l) => a + l.size_bytes, 0)
    : 0;

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Uninstaller")}</h2>
          <p className="view-sub">{dt("Remove an app together with everything it left behind")}</p>
        </div>
        <button className="btn" onClick={scan} disabled={scanning}>
          {dt(scanning ? "Scanning…" : "Rescan")}
        </button>
      </div>

      {error && (
        <div className="banner-error">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      {scanning && !apps && (
        <div className="empty-state">
          <div className="spinner" />
          <p>{dt("Listing installed apps and their sizes…")}</p>
        </div>
      )}

      <div className={`uninstall-layout ${selected ? "with-panel" : ""}`}>
        <div className="findings">
          {apps?.map((a) => (
            <button
              key={a.path}
              className={`app-row ${selected?.path === a.path ? "is-selected" : ""}`}
              onClick={() => select(a)}
            >
              <span className="finding-name">{a.name}</span>
              {a.version && <span className="badge stale">{dt("v")}{a.version}</span>}
              {a.last_used_days != null && a.last_used_days > 90 && (
                <span className="badge safety-caution">{dt("Unused {n} mo", { n: Math.round(a.last_used_days / 30) })}</span>
              )}
              <span className="app-size">
                {formatBytes(a.size_bytes)}
                {a.data_bytes > 0 && (
                  <span className="app-data">{dt(" + {size} data", { size: formatBytes(a.data_bytes) })}</span>
                )}
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <div className="panel">
            <div className="panel-head">
              <span className="finding-name">{selected.name}</span>
              <button className="btn-ghost sm" onClick={() => setSelected(null)}>{dt("Close")}</button>
            </div>
            {selected.bundle_id && <code className="finding-path">{selected.bundle_id}</code>}

            <label className="check-row">
              <input
                type="checkbox"
                checked={checked.has(selected.path)}
                onChange={() => toggle(selected.path)}
              />
              <span className="child-name">{dt("App bundle")}</span>
              <span className="child-size">{formatBytes(selected.size_bytes)}</span>
            </label>

            <h3 className="section-title" style={{ marginTop: 14 }}>
              {dt("Related data")} {leftovers ? dt("({p0})", { p0: leftovers.length }) : dt("")}
            </h3>
            {!leftovers && <div className="spinner sm" />}
            {leftovers?.length === 0 && <p className="view-sub">{dt("No leftover data found.")}</p>}
            {leftovers?.map((l) => (
              <label key={l.path} className="check-row" title={l.path}>
                <input
                  type="checkbox"
                  checked={checked.has(l.path)}
                  onChange={() => toggle(l.path)}
                />
                <span className="child-name">{dt(l.label)}</span>
                {!l.confident && <span className="badge safety-caution">{dt("Name match")}</span>}
                <span className="child-size">{formatBytes(l.size_bytes)}</span>
              </label>
            ))}

            <div className="panel-foot">
              {confirming ? (
                <span className="confirm">
                  <button className="btn-danger" onClick={uninstall} disabled={working}>
                    {dt(working ? "Removing…" : "Move {size} to Trash", { size: formatBytes(selectedTotal) })}
                  </button>
                  <button className="btn-ghost" onClick={() => setConfirming(false)}>{dt("Cancel")}</button>
                </span>
              ) : (
                <button
                  className="btn-danger"
                  disabled={checked.size === 0 || working}
                  onClick={() => setConfirming(true)}
                >
                  {dt("Uninstall ({size})", { size: formatBytes(selectedTotal) })}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
