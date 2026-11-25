import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../adapter";
import { listen, type UnlistenFn } from "../adapter";
import { formatBytes, isWindows } from "../format";
import type { Reason, Safety } from "../types";
import { dt } from "../i18n";

const BIN = isWindows ? "Recycle Bin" : "Trash";
/// Rows drawn at once; a bin can hold tens of thousands of items.
const PAGE = 150;

interface BinItem {
  id: string;
  name: string;
  original_path: string | null;
  original_folder: string | null;
  deleted_at: number | null;
  age_days: number | null;
  size_bytes: number;
  is_dir: boolean;
  by_jharu: boolean;
  source: string | null;
  safety: Safety;
  summary: string;
  reasons: Reason[];
}

interface BinReport {
  supported: boolean;
  bin_name: string;
  total_items: number;
  total_bytes: number;
  jharu_items: number;
  jharu_bytes: number;
  other_items: number;
  other_bytes: number;
  items: BinItem[];
  note: string | null;
}

interface LogEntry {
  path: string;
  name: string;
  size_bytes: number;
  time: number;
  source: string;
  in_bin: boolean;
  bin_id: string | null;
  destination_taken: boolean;
}

interface LogReport {
  supported: boolean;
  bin_name: string;
  total_logged: number;
  in_bin: number;
  entries: LogEntry[];
}

interface PurgeOutcome {
  purged: number;
  freed_bytes: number;
  already_gone: number;
  skipped: string[];
  errors: string[];
  cancelled: boolean;
}

interface RestoreOutcome {
  restored: string[];
  skipped: string[];
  errors: string[];
}

type Scope = "all" | "older" | "jharu_older";
type Tab = "bin" | "log";
type Filter = "all" | "jharu" | "other";

interface Plan {
  scope: Scope;
  days: number;
  items: BinItem[];
}

interface Progress {
  phase: "purge" | "restore";
  done: number;
  total: number;
  current: string;
}

/// The same rule the backend applies again right before it purges.
function inScope(i: BinItem, scope: Scope, days: number): boolean {
  const old = i.age_days != null && i.age_days >= days;
  if (scope === "all") return true;
  if (scope === "older") return old;
  return i.by_jharu && old;
}

function agoLabel(days: number | null): string {
  if (days == null) return dt("at an unknown time");
  if (days < 1) return dt("today");
  if (days === 1) return dt("yesterday");
  if (days < 30) return dt("{n} days ago", { n: days });
  if (days < 365) return dt("{n} mo ago", { n: Math.round(days / 30) });
  return dt("{n} yr ago", { n: (days / 365).toFixed(1) });
}

function whenLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export default function RecycleBin({ onRecovered }: { onRecovered: (bytes: number) => void }) {
  const [tab, setTab] = useState<Tab>("bin");
  const [report, setReport] = useState<BinReport | null>(null);
  const [log, setLog] = useState<LogReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [days, setDays] = useState(30);
  const [shown, setShown] = useState(PAGE);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [purged, setPurged] = useState<PurgeOutcome | null>(null);
  const [restored, setRestored] = useState<RestoreOutcome | null>(null);
  const activeToken = useRef<string | null>(null);

  const busy = progress != null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, l] = await Promise.all([
        invoke<BinReport>("bin_list"),
        invoke<LogReport>("bin_log"),
      ]);
      setReport(r);
      setLog(l);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    let unlisten: UnlistenFn | undefined;
    listen<Progress & { token: string }>("bin-progress", (event) => {
      if (event.payload.token !== activeToken.current) return;
      setProgress(event.payload);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [refresh]);

  const days0 = Number.isFinite(days) && days >= 0 ? Math.floor(days) : 0;

  const counts = useMemo(() => {
    const items = report?.items ?? [];
    const pick = (scope: Scope) => {
      const list = items.filter((i) => inScope(i, scope, days0));
      return { n: list.length, bytes: list.reduce((a, i) => a + i.size_bytes, 0) };
    };
    return { all: pick("all"), older: pick("older"), jharuOlder: pick("jharu_older") };
  }, [report, days0]);

  const visible = useMemo(() => {
    const items = report?.items ?? [];
    return filter === "all"
      ? items
      : items.filter((i) => (filter === "jharu" ? i.by_jharu : !i.by_jharu));
  }, [report, filter]);

  const choose = (scope: Scope) => {
    if (!report) return;
    setPlan({ scope, days: days0, items: report.items.filter((i) => inScope(i, scope, days0)) });
  };

  const purge = async () => {
    if (!plan) return;
    const { scope, days: planDays, items } = plan;
    setPlan(null);
    setPurged(null);
    setRestored(null);
    const token = `bin:${Math.random()}`;
    activeToken.current = token;
    setProgress({ phase: "purge", done: 0, total: items.length, current: "" });
    try {
      const result = await invoke<PurgeOutcome>("bin_purge", {
        items: items.map((i) => ({ id: i.id, deleted: i.deleted_at })),
        scope,
        days: planDays,
        token,
      });
      setPurged(result);
      if (result.errors.length) setError(result.errors.join("; "));
      onRecovered(result.freed_bytes);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      activeToken.current = null;
      setProgress(null);
    }
  };

  const cancel = () => {
    if (activeToken.current) invoke("bin_cancel", { token: activeToken.current }).catch(() => {});
  };

  const restore = async (ids: string[]) => {
    if (ids.length === 0) return;
    setPurged(null);
    setRestored(null);
    const token = `bin:${Math.random()}`;
    activeToken.current = token;
    setProgress({ phase: "restore", done: 0, total: ids.length, current: "" });
    try {
      const result = await invoke<RestoreOutcome>("bin_restore", { ids, token });
      setRestored(result);
      if (result.errors.length) setError(result.errors.join("; "));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      activeToken.current = null;
      setProgress(null);
    }
  };

  const reveal = (path: string) =>
    invoke("reveal_path", { path }).catch((e) => setError(String(e)));

  const planTitle = (p: Plan) =>
    p.scope === "all"
      ? dt("Empty the {bin}?", { bin: dt(BIN) })
      : p.scope === "older"
        ? dt("Empty items older than {n} days?", { n: p.days })
        : dt("Empty Env-Tools's items older than {n} days?", { n: p.days });

  const restorable = (log?.entries ?? []).filter((e) => e.in_bin && !e.destination_taken && e.bin_id);

  return (
    <>
      {plan && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPlan(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{planTitle(plan)}</h3>
            <p className="modal-warn">{dt("This deletes them permanently. It cannot be undone: once they leave the")}{dt(" ")}{dt(BIN)}{dt(" ")}{dt("they cannot be restored, by Env-Tools or by anything else.")}</p>
            <p className="modal-body">
              {plan.scope === "jharu_older"
                ? dt("Only items Env-Tools itself moved here are included. Your own deleted files stay.")
                : plan.items.some((i) => !i.by_jharu)
                  ? dt("This includes files you deleted yourself, not only what Env-Tools moved here.")
                  : dt("Everything included was moved here by Env-Tools.")}{dt(" ")}{dt(" ")}{dt("Each item is checked again just before it goes; anything that changed is skipped.")}</p>
            <div className="modal-items">
              {plan.items.slice(0, 4).map((i) => (
                <code key={i.id} className="modal-item">{i.original_path ?? i.name}</code>
              ))}
              {plan.items.length > 4 && (
                <span className="modal-more">{dt("and")}{dt(" ")}{(plan.items.length - 4).toLocaleString()}{dt(" ")}{dt("more")}</span>
              )}
            </div>
            <div className="modal-total">
              <span>
                {plural(plan.items.length, dt("item"), dt("items"))}{dt(" ")}{dt("· space freed")}</span>
              <strong>{formatBytes(plan.items.reduce((a, i) => a + i.size_bytes, 0))}</strong>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPlan(null)}>{dt("No, keep them")}</button>
              <button className="btn-danger" onClick={purge} disabled={plan.items.length === 0}>{dt("Delete permanently")}</button>
            </div>
          </div>
        </div>
      )}

      <div className="view-head">
        <div>
          <h2 className="view-title">{dt(BIN)}</h2>
          <p className="view-sub">{dt("What is waiting in the {bin}, and everything Env-Tools has moved there — put it back or empty it for real", { bin: dt(BIN) })}</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading || busy}>
          {loading ? dt("Reading…") : dt("Rescan")}
        </button>
      </div>

      {error && (
        <div className="banner-error">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      {progress && (
        <div className="banner-info bin-progress">
          <div className="meter-head">
            <span>
              {progress.phase === "purge" ? dt("Emptying the {p0} permanently", { p0: dt(BIN) }) : dt("Putting items back", {  })}
              {progress.current && dt(" · {p0}", { p0: progress.current })}
            </span>
            <span className="meter-value">
              {Math.min(progress.done, progress.total).toLocaleString()}{dt(" ")}{dt("of")}{dt(" ")}
              {progress.total.toLocaleString()}
            </span>
          </div>
          <div className="meter-track">
            <div
              className="meter-fill"
              style={{
                width: `${Math.max(3, (progress.done / (progress.total || 1)) * 100)}%`,
                background: progress.phase === "purge" ? "var(--danger)" : "var(--accent)",
              }}
            />
          </div>
          {progress.phase === "purge" && (
            <button className="btn-ghost sm" onClick={cancel}>{dt("Stop after this batch")}</button>
          )}
        </div>
      )}

      {purged && !progress && (
        <div className="banner-info">
          {purged.cancelled && dt("Stopped. ")}{dt(" ")}{dt("Permanently deleted")}{dt(" ")}{plural(purged.purged, dt("item"), dt("items"))} ({formatBytes(purged.freed_bytes)}).{dt(" ")}
          {purged.already_gone > 0 &&
            dt("{p0} already gone. ", { p0: plural(purged.already_gone, "item was", "items were") })}
          {purged.skipped.length > 0 && (
            <>{dt("Skipped")}{dt(" ")}{purged.skipped.length}:
              <ul className="bin-list-plain">
                {purged.skipped.slice(0, 8).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {restored && !progress && (
        <div className="banner-info">
          {restored.restored.length > 0 && (
            <>{dt("Put back")}{dt(" ")}{plural(restored.restored.length, dt("item"), dt("items"))}. </>
          )}
          {restored.skipped.length > 0 && (
            <>{dt("Skipped")}{dt(" ")}{restored.skipped.length}:
              <ul className="bin-list-plain">
                {restored.skipped.slice(0, 8).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {restored.restored.length === 0 && restored.skipped.length === 0 && dt("Nothing to put back.")}
        </div>
      )}

      {loading && !report && (
        <div className="empty-state">
          <div className="spinner" />
          <p>{dt("Reading the")}{dt(" ")}{dt(BIN)}…</p>
        </div>
      )}

      {report && !report.supported && (
        <div className="banner-info">{dt("Env-Tools can manage the {bin} on Windows and macOS only.", { bin: dt(BIN) })}</div>
      )}

      {report && report.supported && (
        <>
          <section className="metrics">
            <div className="metric accent">
              <span className="metric-label">{dt("In the {bin}", { bin: dt(BIN) })}</span>
              <span className="metric-value">{formatBytes(report.total_bytes)}</span>
              <span className="metric-sub">{plural(report.total_items, dt("item"), dt("items"))}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("Moved here by Env-Tools")}</span>
              <span className="metric-value">{formatBytes(report.jharu_bytes)}</span>
              <span className="metric-sub">{plural(report.jharu_items, dt("item"), dt("items"))}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("Your own deleted files")}</span>
              <span className="metric-value">{formatBytes(report.other_bytes)}</span>
              <span className="metric-sub">{plural(report.other_items, dt("item"), dt("items"))}</span>
            </div>
          </section>

          <div className="filter-row">
            <div className="filter-tabs">
              <button
                className={`filter-tab ${tab === "bin" ? "is-active" : ""}`}
                onClick={() => setTab("bin")}
              >{dt("In the {bin} ({n})", { bin: dt(BIN), n: report.total_items.toLocaleString() })}
              </button>
              <button
                className={`filter-tab ${tab === "log" ? "is-active" : ""}`}
                onClick={() => setTab("log")}
              >{dt("Restore log ({n})", { n: (log?.total_logged ?? 0).toLocaleString() })}
              </button>
            </div>
          </div>

          {tab === "bin" && (
            <>
              {report.note && <div className="banner-info">{report.note}</div>}

              <section className="bin-empty-panel">
                <div className="bin-empty-head">
                  <h2 className="section-title">{dt("Empty the {bin}", { bin: dt(BIN) })}</h2>
                  <label className="bin-days">{dt("Older than")}{dt(" ")}<input
                      type="number"
                      min={0}
                      max={3650}
                      value={Number.isFinite(days) ? days : 0}
                      onChange={(e) => setDays(parseInt(e.target.value, 10))}
                      disabled={busy}
                    />{dt(" ")}{dt("days")}</label>
                </div>
                <div className="bin-empty-actions">
                  <button
                    className="btn-clean"
                    disabled={busy || counts.jharuOlder.n === 0}
                    onClick={() => choose("jharu_older")}
                  >{dt("Env-Tools's items older than")}{dt(" ")}{days0}{dt(" ")}{dt("days ·")}{dt(" ")}{counts.jharuOlder.n.toLocaleString()} ·{dt(" ")}
                    {formatBytes(counts.jharuOlder.bytes)}
                  </button>
                  <button
                    className="btn-clean"
                    disabled={busy || counts.older.n === 0}
                    onClick={() => choose("older")}
                  >{dt("Everything older than")}{dt(" ")}{days0}{dt(" ")}{dt("days ·")}{dt(" ")}{counts.older.n.toLocaleString()} ·{dt(" ")}
                    {formatBytes(counts.older.bytes)}
                  </button>
                  <button
                    className="btn-clean"
                    disabled={busy || counts.all.n === 0}
                    onClick={() => choose("all")}
                  >{dt("Empty everything ·")}{dt(" ")}{counts.all.n.toLocaleString()} · {formatBytes(counts.all.bytes)}
                  </button>
                </div>
                <p className="model-meta">{dt("Emptying is permanent. Env-Tools asks once more with the total before it deletes anything.")}</p>
              </section>

              <div className="filter-row">
                <div className="filter-tabs">
                  {(
                    [
                      ["all", dt("All ({p0})", { p0: report.total_items.toLocaleString() })],
                      ["jharu", dt("Moved by Env-Tools ({p0})", { p0: report.jharu_items.toLocaleString() })],
                      ["other", dt("Your own ({p0})", { p0: report.other_items.toLocaleString() })],
                    ] as [Filter, string][]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={`filter-tab ${filter === id ? "is-active" : ""}`}
                      onClick={() => {
                        setFilter(id);
                        setShown(PAGE);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {visible.length === 0 && (
                <div className="empty-state">
                  <p>
                    {report.total_items === 0
                      ? dt("The {p0} is empty.", { p0: dt(BIN) })
                      : dt("Nothing in this group.")}
                  </p>
                </div>
              )}

              {visible.length > 0 && (
                <div className="findings">
                  {visible.slice(0, shown).map((i) => (
                    <div key={i.id} className="model-row bin-row">
                      <div className="model-main">
                        <div className="finding-title">
                          <span className="finding-name">{i.name}</span>
                          <span className={`badge safety-${i.safety}`}>{i.summary}</span>
                          {i.source && <span className="badge cat-dev_cache">{i.source}</span>}
                        </div>
                        <span className="model-meta">
                          {i.is_dir ? dt("Folder") : dt("File")}{dt(" ")}{dt("· deleted")}{dt(" ")}{agoLabel(i.age_days)}
                          {i.deleted_at != null && dt(" ({p0})", { p0: whenLabel(i.deleted_at) })}
                        </span>
                        {i.original_folder && <code className="finding-path">{i.original_folder}</code>}
                        <ul className="safety-reasons">
                          {i.reasons.map((r) => (
                            <li key={r.text} className={`reason-${r.level}`}>
                              <span className="reason-mark" aria-hidden>
                                {r.level === "ok" ? dt("✓") : r.level === "warn" ? dt("!") : dt("✕")}
                              </span>
                              {r.text}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="finding-size">
                        <span className="size">{formatBytes(i.size_bytes)}</span>
                      </div>
                      <button
                        className="btn sm"
                        disabled={busy || !i.original_path}
                        title={
                          i.original_path
                            ? dt("Put back at {p0}", { p0: i.original_path })
                            : dt("Env-Tools does not know where this came from")
                        }
                        onClick={() => restore([i.id])}
                      >{dt("Put back")}</button>
                    </div>
                  ))}
                </div>
              )}
              {visible.length > shown && (
                <div className="bin-more">
                  <button className="btn" onClick={() => setShown((s) => s + PAGE)}>{dt("Show")}{dt(" ")}{Math.min(PAGE, visible.length - shown).toLocaleString()}{dt(" ")}{dt("more (")}{dt(" ")}{(visible.length - shown).toLocaleString()}{dt(" ")}{dt("not shown)")}</button>
                </div>
              )}
            </>
          )}

          {tab === "log" && log && (
            <>
              <div className="banner-info">{dt("Env-Tools writes down everything it moves to the")}{dt(" ")}{dt(BIN)}{dt(": where it was, how big, when, and which tab did it. Items that are still in the")}{dt(" ")}{dt(BIN)}{dt(" ")}{dt("can be put back with one click. Once an item leaves the")}{dt(" ")}{dt(BIN)}{dt(" ")}{dt("(restored, or emptied) it stays in the log for the record but cannot be put back.")}</div>
              <div className="filter-row">
                <span className="model-meta">
                  {log.in_bin.toLocaleString()}{dt(" ")}{dt("of")}{dt(" ")}{log.total_logged.toLocaleString()}{dt(" ")}{dt("logged items are still in the")}{dt(" ")}{dt(BIN)}
                  {log.total_logged > log.entries.length &&
                    dt(" · showing the newest {p0}", { p0: log.entries.length })}
                </span>
                {restorable.length > 0 && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => restore(restorable.map((e) => e.bin_id as string))}
                  >{dt("Put back all")}{dt(" ")}{restorable.length.toLocaleString()}{dt(" ")}{dt("that can be")}</button>
                )}
              </div>
              {log.entries.length === 0 ? (
                <div className="empty-state">
                  <p>{dt("Nothing logged yet. Items Env-Tools moves to the")}{dt(" ")}{dt(BIN)}{dt(" ")}{dt("will appear here.")}</p>
                </div>
              ) : (
                <div className="findings">
                  {log.entries.slice(0, shown).map((e, n) => (
                    <div key={`${e.time}:${e.path}:${n}`} className="model-row bin-row">
                      <div className="model-main">
                        <div className="finding-title">
                          <span className="finding-name">{e.name}</span>
                          <span className="badge cat-dev_cache">{e.source}</span>
                          {!e.in_bin && <span className="badge stale">{dt("Left the")}{dt(" ")}{dt(BIN)}</span>}
                        </div>
                        <span className="model-meta">{dt("Moved")}{dt(" ")}{whenLabel(e.time)} · {formatBytes(e.size_bytes)}
                          {!e.in_bin && dt(" · restored or emptied since")}
                          {e.in_bin && e.destination_taken && dt(" · something is at the original place now")}
                        </span>
                        <code className="finding-path">{e.path}</code>
                      </div>
                      {e.in_bin && e.bin_id ? (
                        <button
                          className="btn sm"
                          disabled={busy || e.destination_taken}
                          title={
                            e.destination_taken
                              ? dt("Move or rename what is there first; Env-Tools never overwrites")
                              : dt("Put back at {p0}", { p0: e.path })
                          }
                          onClick={() => restore([e.bin_id as string])}
                        >{dt("Put back")}</button>
                      ) : (
                        <button className="btn-ghost sm" onClick={() => reveal(e.path)}>{dt("Show")}</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {log.entries.length > shown && (
                <div className="bin-more">
                  <button className="btn" onClick={() => setShown((s) => s + PAGE)}>{dt("Show more")}</button>
                </div>
              )}
            </>
          )}

          <p className="footnote">{dt("Rating: what Env-Tools removed from a cache that its tool rebuilds by itself is safe to empty; everything else is your own data or Env-Tools cannot tell what it is, so it is marked \"check first\". Putting an item back never overwrites a file that is already in its place.")}</p>
        </>
      )}
    </>
  );
}
