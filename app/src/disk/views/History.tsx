import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../adapter";
import { listen, type UnlistenFn } from "../adapter";
import { formatBytes, isWindows } from "../format";
import ConfirmClean from "../components/ConfirmClean";
import type { SpaceForecast } from "../components/ForecastNote";
import type { Verdict } from "../types";
import { dt } from "../i18n";

const BIN = isWindows ? "Recycle Bin" : "Trash";

interface SeriesPoint {
  ts: number;
  used: number;
}

interface DriveSeries {
  mount: string;
  total: number;
  used: number;
  free: number;
  removable: boolean;
  points: SeriesPoint[];
  forecast: SpaceForecast;
}

interface SnapshotInfo {
  ts: number;
  source: string;
  folders: number;
}

interface RootInfo {
  root: string;
  snapshots: SnapshotInfo[];
}

interface CleanedItem {
  name: string;
  path: string;
  bytes: number;
}

interface CleanRun {
  ts: number;
  trigger: "scheduled" | "manual" | "preview";
  freed_bytes: number;
  removed: CleanedItem[];
  skipped: string[];
  errors: string[];
}

interface Settings {
  check_hours: number;
  alerts_enabled: boolean;
  low_space_gb: number;
  clean_enabled: boolean;
  clean_every_days: number;
  clean_idle_days: number;
}

interface Overview {
  now: number;
  drives: DriveSeries[];
  roots: RootInfo[];
  runs: CleanRun[];
  settings: Settings;
  state: { last_check: number; last_clean: number };
  busy: boolean;
  retention_days: number;
}

interface FolderChange {
  path: string;
  label: string;
  old_bytes: number;
  new_bytes: number;
  delta: number;
  is_new: boolean;
  is_gone: boolean;
  covered: boolean;
}

interface DriveDelta {
  mount: string;
  total: number;
  used_from: number;
  used_to: number;
  free_from: number;
  free_to: number;
  free_delta: number;
}

interface Comparison {
  available: boolean;
  note: string | null;
  root: string | null;
  from_ts: number;
  to_ts: number;
  drives: DriveDelta[];
  grown: FolderChange[];
  shrunk: FolderChange[];
}

interface PathVerdict {
  exists: boolean;
  protected: boolean;
  hint: string;
  verdict: Verdict | null;
}

interface Progress {
  stage: string;
  done: number;
  total: number;
  current: string;
}

const GB = 1024 ** 3;
const GROWN_SHOWN = 12;
const SHRUNK_SHOWN = 8;
/// Ratings are fetched for this many of the biggest changes without asking.
const AUTO_VERDICTS = 5;

const date = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const driveName = (mount: string) => mount.replace(/[\\/]+$/, "") || mount;
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const signed = (n: number) => `${n < 0 ? "-" : "+"}${formatBytes(Math.abs(n))}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function verdictLabel(v: Verdict): string {
  if (v.basis === "unknown") return dt("Unknown: look inside");
  if (v.safety === "safe") return dt("Safe to remove");
  if (v.safety === "caution") return dt("Remove with care");
  return dt("Review first");
}

/// "C: lost 18 GB of free space since Oct 22: +12 GB Screen recordings, +6 GB editor\target"
function headlines(c: Comparison): string[] {
  const top = c.grown.filter((g) => !g.covered).slice(0, 3);
  const root = c.root ? norm(c.root) : "";
  const out: string[] = [];
  for (const d of c.drives) {
    if (Math.abs(d.free_delta) < GB) continue;
    const lost = d.free_delta < 0;
    let line = `${driveName(d.mount)} ${lost ? "lost" : "gained"} ${formatBytes(Math.abs(d.free_delta))} of free space since ${date(c.from_ts)}`;
    // The folders explain the drive that holds the scanned root.
    const holdsRoot = root.startsWith(norm(d.mount));
    if (lost && holdsRoot && top.length > 0) {
      line += `: ${top.map((g) => `${signed(g.delta)} ${g.label}`).join(", ")}`;
    }
    out.push(line);
  }
  return out;
}

function Spark({ points, total }: { points: SeriesPoint[]; total: number }) {
  const W = 320;
  const H = 56;
  if (points.length < 2) {
    return <p className="hs-note">{dt("One reading so far. The chart appears after a second day.")}</p>;
  }
  const t0 = points[0].ts;
  const span = Math.max(1, points[points.length - 1].ts - t0);
  const values = points.map((p) => p.used);
  const lo = Math.min(...values);
  const hi = Math.max(...values, lo + 1);
  const pad = (hi - lo) * 0.15 || total * 0.01;
  const y = (v: number) => H - 4 - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - 8);
  const line = points.map((p) => `${(((p.ts - t0) / span) * (W - 8) + 4).toFixed(1)},${y(p.used).toFixed(1)}`).join(" ");
  return (
    <svg
      className="hs-spark"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={dt("Used space from {p0} to {p1} over {p2} days", { p0: formatBytes(values[0]), p1: formatBytes(values[values.length - 1]), p2: points.length })}
    >
      <polyline points={line} fill="none" stroke="var(--c-user)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Reasons({ v }: { v: Verdict }) {
  return (
    <ul className="safety-reasons deep-why">
      {v.what && <li className="deep-what">{v.what}</li>}
      {v.reasons.map((r) => (
        <li key={r.text} className={`reason-${r.level}`}>
          <span className="reason-mark" aria-hidden>
            {r.level === "ok" ? dt("✓") : r.level === "warn" ? dt("!") : dt("✕")}
          </span>
          {r.text}
        </li>
      ))}
    </ul>
  );
}

export default function History({ onRecovered }: { onRecovered: (bytes: number) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [compare, setCompare] = useState<Comparison | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [taking, setTaking] = useState(false);
  const [showShrunk, setShowShrunk] = useState(false);
  const [showCovered, setShowCovered] = useState(false);
  const [verdicts, setVerdicts] = useState<Record<string, PathVerdict | "loading" | "error">>({});
  const [draft, setDraft] = useState<Settings | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<CleanRun | null>(null);
  const [working, setWorking] = useState<"preview" | "run" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastRun, setLastRun] = useState<CleanRun | null>(null);
  const rootRef = useRef<string | null>(null);
  const fromRef = useRef<number | null>(null);
  rootRef.current = root;
  fromRef.current = from;

  const loadCompare = useCallback(async (r: string | null, f: number | null) => {
    try {
      setCompare(await invoke<Comparison>("history_compare", { root: r, fromTs: f }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const o = await invoke<Overview>("history_overview");
      setOverview(o);
      setDraft((d) => d ?? o.settings);
      await loadCompare(rootRef.current, fromRef.current);
    } catch (e) {
      setError(String(e));
    }
  }, [loadCompare]);

  useEffect(() => {
    refresh();
    const unlistens: Promise<UnlistenFn>[] = [
      listen<Progress>("history-progress", (e) => {
        const p = e.payload;
        // The last event of a job has everything done: nothing left to show.
        setProgress(!p.stage || (p.total > 0 && p.done >= p.total) ? null : p);
      }),
      listen("history-snapshot", () => {
        setProgress(null);
        refresh();
      }),
    ];
    return () => {
      unlistens.forEach((u) => u.then((f) => f()));
    };
  }, [refresh]);

  // The roots with snapshots, and which one and which baseline are shown.
  const roots = overview?.roots ?? [];
  const activeRoot = root ?? compare?.root ?? roots[0]?.root ?? null;
  const rootInfo = roots.find((r) => activeRoot && norm(r.root) === norm(activeRoot));
  const baselines = (rootInfo?.snapshots ?? []).slice(1);

  const chooseRoot = (r: string) => {
    setRoot(r);
    setFrom(null);
    loadCompare(r, null);
  };
  const chooseFrom = (value: string) => {
    const f = value === "auto" ? null : Number(value);
    setFrom(f);
    loadCompare(activeRoot, f);
  };

  // Ratings for the biggest changes, one after another, so that "what grew"
  // arrives with "is it safe to remove".
  const askVerdict = useCallback(async (path: string) => {
    setVerdicts((v) => (v[path] ? v : { ...v, [path]: "loading" }));
    try {
      const r = await invoke<PathVerdict>("history_verdict", { path });
      setVerdicts((v) => ({ ...v, [path]: r }));
    } catch {
      setVerdicts((v) => ({ ...v, [path]: "error" }));
    }
  }, []);

  useEffect(() => {
    if (!compare?.available) return;
    let live = true;
    (async () => {
      for (const g of compare.grown.filter((x) => !x.covered && !x.is_gone).slice(0, AUTO_VERDICTS)) {
        if (!live) return;
        await askVerdict(g.path);
      }
    })();
    return () => {
      live = false;
    };
  }, [compare, askVerdict]);

  const takeSnapshot = async () => {
    setTaking(true);
    setError(null);
    setProgress({ stage: "Measuring folders", done: 0, total: 0, current: "" });
    try {
      await invoke<number>("history_snapshot_now", { root: null });
      await refresh();
    } catch (e) {
      const msg = String(e);
      if (msg !== "Cancelled.") setError(msg);
    } finally {
      setTaking(false);
      setProgress(null);
    }
  };

  const grown = useMemo(() => {
    const all = compare?.grown ?? [];
    return (showCovered ? all : all.filter((g) => !g.covered)).slice(0, GROWN_SHOWN);
  }, [compare, showCovered]);
  const shrunk = useMemo(() => {
    const all = compare?.shrunk ?? [];
    return (showCovered ? all : all.filter((g) => !g.covered)).slice(0, SHRUNK_SHOWN);
  }, [compare, showCovered]);
  const coveredCount = (compare?.grown ?? []).filter((g) => g.covered).length + (compare?.shrunk ?? []).filter((g) => g.covered).length;
  const maxDelta = Math.max(1, ...grown.map((g) => g.delta));

  // ---- settings and scheduled cleaning

  const dirty = overview && draft && JSON.stringify(overview.settings) !== JSON.stringify(draft);
  const patch = (p: Partial<Settings>) => {
    setSavedNote(null);
    setDraft((d) => (d ? { ...d, ...p } : d));
  };
  const save = async () => {
    if (!draft) return;
    try {
      const s = await invoke<Settings>("autocare_set", { settings: draft });
      setDraft(s);
      setSavedNote(s.clean_enabled ? dt("Saved. Scheduled cleaning is on.") : dt("Saved."));
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const runPreview = async () => {
    setWorking("preview");
    setPreview(null);
    setLastRun(null);
    setError(null);
    setProgress({ stage: "Looking at your caches", done: 0, total: 0, current: "" });
    try {
      // The settings on screen are used as they are, without saving them.
      setPreview(await invoke<CleanRun>("autocare_preview", { settings: draft }));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
      setProgress(null);
    }
  };

  const runNow = async () => {
    setConfirming(false);
    setWorking("run");
    setError(null);
    setProgress({ stage: "Cleaning safe caches", done: 0, total: 0, current: "" });
    try {
      // Only what the confirmation listed.
      const r = await invoke<CleanRun>("autocare_run_now", { paths: preview?.removed.map((i) => i.path) ?? [], settings: draft });
      setLastRun(r);
      setPreview(null);
      onRecovered(r.freed_bytes);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
      setProgress(null);
    }
  };

  const cancel = () => invoke("history_cancel").catch(() => {});
  const reveal = (path: string) => invoke("reveal_path", { path }).catch((e) => setError(String(e)));

  const busyWork = taking || working != null;
  const total = overview?.roots.reduce((n, r) => n + r.snapshots.length, 0) ?? 0;

  return (
    <>
      {confirming && preview && (
        <ConfirmClean
          request={{
            kind: "cache",
            title: `Clean ${plural(preview.removed.length, "cache", "caches")} now?`,
            items: preview.removed.map((i) => i.path),
            bytes: preview.freed_bytes,
          }}
          busy={working === "run"}
          onConfirm={runNow}
          onCancel={() => setConfirming(false)}
        />
      )}

      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Space history")}</h2>
          <p className="view-sub">{dt("What grew since last time, when each drive fills up, and low-space alerts")}</p>
        </div>
        {taking ? (
          <button className="btn" onClick={cancel}>{dt("Cancel")}</button>
        ) : (
          <button className="btn" onClick={takeSnapshot} disabled={busyWork}>{dt("Take a snapshot now")}</button>
        )}
      </div>

      {error && (
        <div className="banner-error">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      {progress && (
        <div className="banner-info hs-progress">
          <div className="meter-head">
            <span>
              {progress.stage}
              {progress.current && dt(" · {p0}", { p0: progress.current })}
            </span>
            {progress.total > 0 && (
              <span className="meter-value">
                {Math.min(progress.done, progress.total)}{dt(" ")}{dt("of")}{dt(" ")}{progress.total}
              </span>
            )}
          </div>
          <div className="meter-track">
            <div
              className="meter-fill"
              style={{
                width: `${progress.total > 0 ? Math.max(3, (progress.done / progress.total) * 100) : 12}%`,
                background: "var(--accent)",
              }}
            />
          </div>
          <div className="hs-progress-actions">
            <button className="btn-ghost sm" onClick={cancel}>{dt("Cancel")}</button>
          </div>
        </div>
      )}

      {!overview && !error && (
        <div className="empty-state"><div className="spinner" /><p>{dt("Reading the history…")}</p></div>
      )}

      {overview && (
        <>
          <h2 className="section-title">{dt("Forecast")}</h2>
          {overview.drives.length === 0 && (
            <div className="empty-state"><p>{dt("No drive readings yet. Env-Tools records one when it starts and every few hours after.")}</p></div>
          )}
          <div className="hs-drives">
            {overview.drives.map((d) => (
              <div key={d.mount} className="hs-drive">
                <div className="hs-drive-head">
                  <span className="finding-name">{driveName(d.mount)}</span>
                  <span className="model-meta">
                    {formatBytes(d.free)}{dt(" ")}{dt("free of")}{dt(" ")}{formatBytes(d.total)}
                    {d.removable && dt(" · removable")}
                  </span>
                </div>
                <Spark points={d.points} total={d.total} />
                <p className={`hs-forecast hs-trend-${d.forecast.trend}`}>{d.forecast.summary}</p>
              </div>
            ))}
          </div>
          <p className="footnote left">{dt("Readings are kept for")}{dt(" ")}{overview.retention_days}{dt(" ")}{dt("days, one per day once they are older than two days. The forecast is the median of the day-to-day trend over the last 30 days, so one big download or cleanup does not swing it.")}</p>

          <h2 className="section-title">{dt("What grew")}</h2>
          {compare && !compare.available && (
            <div className="banner-info">
              {compare.note}
              {total === 0 && (
                <>
                  {dt(" ")}
                  <button className="btn-ghost sm" onClick={takeSnapshot} disabled={busyWork}>{dt("Take a snapshot of your home folder")}</button>
                </>
              )}
            </div>
          )}

          {compare?.available && (
            <>
              <div className="hs-controls">
                {roots.length > 1 && (
                  <label>{dt("Folder")}{dt(" ")}
                    <select value={activeRoot ?? ""} onChange={(e) => chooseRoot(e.target.value)}>
                      {roots.map((r) => (
                        <option key={r.root} value={r.root}>{r.root}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label>{dt("Compare")}{dt(" ")}{dateTime(compare.to_ts)}{dt(" ")}{dt("with")}{dt(" ")}
                  <select value={from == null ? "auto" : String(from)} onChange={(e) => chooseFrom(e.target.value)}>
                    <option value="auto">{dt("about a week earlier (")}{date(compare.from_ts)})</option>
                    {baselines.map((s) => (
                      <option key={s.ts} value={s.ts}>{dateTime(s.ts)}</option>
                    ))}
                  </select>
                </label>
              </div>

              {headlines(compare).map((h) => (
                <p key={h} className="hs-headline">{h}</p>
              ))}
              {headlines(compare).length === 0 && (
                <p className="hs-headline">{dt("No drive's free space changed by 1 GB or more between")}{dt(" ")}{date(compare.from_ts)}{dt(" ")}{dt("and")}{dt(" ")}{date(compare.to_ts)}.
                </p>
              )}

              {grown.length === 0 ? (
                <div className="banner-info">{dt("No folder grew by 50 MB or more in that time.")}</div>
              ) : (
                <div className="findings">
                  {grown.map((g) => {
                    const v = verdicts[g.path];
                    return (
                      <div key={g.path} className="hs-row">
                        <div className="hs-row-main">
                          <div className="finding-title">
                            <span className="finding-name">{g.label}</span>
                            {g.is_new && <span className="badge stale" title={dt("It was not among the largest folders in the older snapshot")}>{dt("new")}</span>}
                            {g.covered && <span className="badge stale" title={dt("Most of this growth is in a folder inside it")}>{dt("contains the growth")}</span>}
                            {typeof v === "object" && v.verdict && (
                              <span
                                className={`badge safety-${v.verdict.basis === "unknown" ? "caution" : v.verdict.safety}`}
                                title={dt("Deep clean's rating of removing this whole folder")}
                              >
                                {verdictLabel(v.verdict)}
                              </span>
                            )}
                            {typeof v === "object" && v.protected && <span className="badge stale">{dt("System location")}</span>}
                          </div>
                          <code className="finding-path">{g.path}</code>
                          <div className="hs-bar" aria-hidden>
                            <div className="hs-bar-fill" style={{ width: `${Math.max(2, (g.delta / maxDelta) * 100)}%` }} />
                          </div>
                          <span className="model-meta">
                            {g.is_new
                              ? dt("{p0} now, not among the largest folders before", { p0: formatBytes(g.new_bytes) })
                              : dt("{p0} then, {p1} now", { p0: formatBytes(g.old_bytes), p1: formatBytes(g.new_bytes) })}
                          </span>
                          {v === "loading" && <span className="model-meta">{dt("Checking whether it is safe to remove…")}</span>}
                          {v === "error" && <span className="model-meta">{dt("Could not check this folder.")}</span>}
                          {typeof v === "object" && !v.exists && <span className="model-meta">{v.hint}</span>}
                          {typeof v === "object" && v.protected && <span className="model-meta">{v.hint}</span>}
                          {typeof v === "object" && v.verdict && <Reasons v={v.verdict} />}
                        </div>
                        <div className="finding-size">
                          <span className="size hs-grew">{signed(g.delta)}</span>
                        </div>
                        <div className="hs-actions">
                          {v === undefined && !g.is_gone && (
                            <button className="btn-ghost sm" onClick={() => askVerdict(g.path)}>{dt("Is it safe?")}</button>
                          )}
                          <button className="btn-ghost sm" onClick={() => reveal(g.path)}>{dt("Show")}</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="hs-toggles">
                {coveredCount > 0 && (
                  <button className="btn-ghost sm" onClick={() => setShowCovered((s) => !s)}>
                    {showCovered ? dt("Hide the folders that only contain the growth") : dt("Also show {p0}", { p0: plural(coveredCount, "enclosing folder", "enclosing folders") })}
                  </button>
                )}
                {(compare.shrunk.length > 0) && (
                  <button className="btn-ghost sm" onClick={() => setShowShrunk((s) => !s)}>
                    {showShrunk ? dt("Hide folders that shrank") : dt("Show folders that shrank")}
                  </button>
                )}
              </div>

              {showShrunk && (
                <div className="findings">
                  {shrunk.map((g) => (
                    <div key={g.path} className="hs-row">
                      <div className="hs-row-main">
                        <div className="finding-title">
                          <span className="finding-name">{g.label}</span>
                          {g.is_gone && <span className="badge stale" title={dt("It was not among the largest folders in the newer snapshot")}>{dt("gone or much smaller")}</span>}
                        </div>
                        <code className="finding-path">{g.path}</code>
                        <span className="model-meta">{formatBytes(g.old_bytes)}{dt(" ")}{dt("then,")}{dt(" ")}{formatBytes(g.new_bytes)}{dt(" ")}{dt("now")}</span>
                      </div>
                      <div className="finding-size">
                        <span className="size">{signed(g.delta)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="footnote left">{dt("Sizes count each file once, like Deep clean. A folder that was not among the largest 300 in the older snapshot is shown as growing by at least its size minus about 20 MB. The safety rating is Deep clean's for removing the whole folder; nothing here removes anything.")}</p>
            </>
          )}

          <h2 className="section-title">{dt("Alerts and scheduled cleaning")}</h2>
          {draft && (
            <div className="hs-settings">
              <div className="hs-setting">
                <label className="hs-check">
                  <input type="checkbox" checked={draft.alerts_enabled} onChange={(e) => patch({ alerts_enabled: e.target.checked })} />
                  <span>{dt("Notify me when a drive is low on free space")}</span>
                </label>
                <div className="hs-fields">
                  <label>{dt("Below")}{dt(" ")}
                    <input
                      type="number"
                      min={1}
                      max={2000}
                      value={draft.low_space_gb}
                      onChange={(e) => patch({ low_space_gb: Number(e.target.value) || 1 })}
                      disabled={!draft.alerts_enabled}
                    />{dt(" ")}{dt(" ")}{dt("GB free")}</label>
                  <label>{dt("Check every")}{dt(" ")}
                    <select value={draft.check_hours} onChange={(e) => patch({ check_hours: Number(e.target.value) })}>
                      {[1, 3, 6, 12, 24].map((h) => (
                        <option key={h} value={h}>{plural(h, dt("hour"), dt("hours"))}</option>
                      ))}
                    </select>
                  </label>
                  <button className="btn-ghost sm" onClick={() => invoke("autocare_test_alert").catch((e) => setError(String(e)))}>{dt("Send a test alert")}</button>
                </div>
                <p className="model-meta">{dt("Removable drives and drives under 20 GB are ignored. Each drive is mentioned at most once a day.")}{dt(" ")}{overview.state.last_check > 0 && dt(" Last check: {p0}.", { p0: dateTime(overview.state.last_check) })}
                </p>
              </div>

              <div className="hs-setting">
                <label className="hs-check">
                  <input type="checkbox" checked={draft.clean_enabled} onChange={(e) => patch({ clean_enabled: e.target.checked })} />
                  <span>
                    <strong>{dt("Clean safe caches on a schedule")}</strong>{dt(" ")}{dt("(off by default)")}</span>
                </label>
                <div className="hs-fields">
                  <label>{dt("Every")}{dt(" ")}
                    <input
                      type="number"
                      min={1}
                      max={90}
                      value={draft.clean_every_days}
                      onChange={(e) => patch({ clean_every_days: Number(e.target.value) || 1 })}
                      disabled={!draft.clean_enabled}
                    />{dt(" ")}{dt(" ")}{dt("days")}</label>
                  <label>{dt("Only caches idle for")}{dt(" ")}
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={draft.clean_idle_days}
                      onChange={(e) => patch({ clean_idle_days: Number(e.target.value) || 1 })}
                    />{dt(" ")}{dt(" ")}{dt("days")}</label>
                </div>
                <ul className="hs-rules">
                  <li>{dt("Only Dev clean findings rated")}{dt(" ")}<strong>{dt("Safe")}</strong>{dt(" ")}{dt("whose tool rebuilds them by itself. Caution and Risky findings, models, environments and Docker are never touched.")}</li>
                  <li>{dt("Each one is checked again right before it is removed: still Safe, no program running from it, nothing changed in it recently.")}</li>
                  <li>{dt("Everything goes to the")}{dt(" ")}{dt(BIN)}{dt(". What was moved is listed below.")}</li>
                  <li>{dt("It never starts while a scan or clean is running, and only runs while Env-Tools is open.")}</li>
                </ul>
                <p className="model-meta">
                  {overview.state.last_clean > 0 ? dt("Last run: {p0}.", { p0: dateTime(overview.state.last_clean) }) : dt("Has not run yet.")}
                </p>
              </div>

              <div className="hs-save">
                <button className="btn" onClick={save} disabled={!dirty}>{dt("Save settings")}</button>
                <button className="btn" onClick={runPreview} disabled={busyWork || overview.busy}>
                  {working === "preview" ? dt("Looking…") : dt("Preview what it would clean")}
                </button>
                {savedNote && !dirty && <span className="model-meta">{savedNote}</span>}
              </div>
            </div>
          )}

          {preview && (
            <div className="hs-preview">
              <h3 className="section-title">
                {preview.removed.length === 0
                  ? dt("Nothing qualifies right now")
                  : dt("Would clean {p0}, {p1}", { p0: plural(preview.removed.length, "cache", "caches"), p1: formatBytes(preview.freed_bytes) })}
              </h3>
              {preview.removed.length > 0 && (
                <>
                  <ul className="hs-list">
                    {preview.removed.map((i) => (
                      <li key={i.path}>
                        <strong>{i.name}</strong> <code>{i.path}</code> <span className="hs-size">{formatBytes(i.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                  <button className="btn-clean" onClick={() => setConfirming(true)} disabled={busyWork}>{dt("Clean these now (")}{formatBytes(preview.freed_bytes)})
                  </button>
                </>
              )}
              {preview.skipped.length > 0 && (
                <details>
                  <summary>{dt("Left alone (")}{preview.skipped.length})</summary>
                  <ul className="hs-list">
                    {preview.skipped.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {lastRun && (
            <div className="banner-info">{dt("Moved")}{dt(" ")}{plural(lastRun.removed.length, dt("cache"), dt("caches"))}{dt(" ")}{dt("to the")}{dt(" ")}{dt(BIN)} ({formatBytes(lastRun.freed_bytes)}).
              {lastRun.skipped.length > 0 && dt(" {p0} left alone; see the log below.", { p0: plural(lastRun.skipped.length, "was", "were") })}
            </div>
          )}

          <h2 className="section-title">{dt("What Env-Tools cleaned")}{dt(" ")}<span className="count">{overview.runs.length}</span>
          </h2>
          {overview.runs.length === 0 ? (
            <p className="view-sub">{dt("Nothing yet. Automatic cleans are written here, with what they moved and what they left.")}</p>
          ) : (
            <div className="findings">
              {overview.runs.map((r) => (
                <details key={r.ts} className="hs-run">
                  <summary>
                    <span className="finding-name">{dateTime(r.ts)}</span>
                    <span className="badge stale">{r.trigger === "scheduled" ? dt("scheduled") : dt("run by you")}</span>
                    <span className="hs-run-sum">
                      {r.removed.length === 0 ? dt("nothing moved") : dt("{p0}, {p1}", { p0: plural(r.removed.length, "cache", "caches"), p1: formatBytes(r.freed_bytes) })}
                    </span>
                  </summary>
                  <ul className="hs-list">
                    {r.removed.map((i) => (
                      <li key={i.path}>{dt("Moved")}{dt(" ")}<strong>{i.name}</strong> <code>{i.path}</code> <span className="hs-size">{formatBytes(i.bytes)}</span>
                      </li>
                    ))}
                    {r.skipped.map((s) => (
                      <li key={s} className="hs-skipped">{dt("Left alone:")}{dt(" ")}{s}</li>
                    ))}
                    {r.errors.map((s) => (
                      <li key={s} className="reason-bad">{s}</li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
