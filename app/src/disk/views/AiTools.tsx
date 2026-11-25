import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../adapter";
import { listen, type UnlistenFn } from "../adapter";
import { formatBytes, isWindows } from "../format";
import type { Reason, Safety } from "../types";
import { dt } from "../i18n";

type Class =
  | "cache"
  | "logs"
  | "download"
  | "history"
  | "state"
  | "extensions"
  | "scratch"
  | "workspace"
  | "link";

interface AgeBucket {
  days: number;
  bytes: number;
  files: number;
}

interface AiItem {
  id: string;
  tool: string;
  label: string;
  class: Class;
  path: string;
  paths: string[];
  size_bytes: number;
  file_count: number;
  modified_days: number | null;
  safety: Safety;
  reasons: Reason[];
  explanation: string;
  removable: boolean;
  preselect: boolean;
  tool_running: boolean;
  ages: AgeBucket[];
  link: string | null;
}

interface AiTool {
  id: string;
  name: string;
  running: string[];
  total_bytes: number;
  safe_bytes: number;
  items: AiItem[];
  worktrees_link: boolean;
}

interface AiReport {
  total_bytes: number;
  safe_bytes: number;
  history_bytes: number;
  tools: AiTool[];
}

interface AiRemoveOutcome {
  freed_bytes: number;
  moved: number;
  removed: string[];
  already_gone: string[];
  skipped: string[];
  errors: string[];
  cancelled: boolean;
}

interface Progress {
  done: number;
  total: number;
  current: string;
  step_done: number;
  step_total: number;
}

type Filter = "all" | "clearable" | "history";

const BIN = isWindows ? "Recycle Bin" : "Trash";
const COLLAPSED_ROWS = 8;

const SAFETY_LABEL: Record<Safety, string> = {
  safe: "Safe to clear",
  caution: "Check first",
  risky: "Review first",
};

const CLASS_LABEL: Record<Class, string> = {
  cache: "Cache",
  logs: "Logs",
  download: "Re-downloads",
  history: "Chat history",
  state: "Saved state",
  extensions: "Extensions",
  scratch: "Agent output",
  workspace: "Project storage",
  link: "Worktrees",
};

function ageLabel(days: number | null): string {
  if (days == null) return dt("unknown");
  if (days < 1) return dt("today");
  if (days < 30) return dt("{n}d ago", { n: days });
  if (days < 365) return dt("{n} mo ago", { n: Math.round(days / 30) });
  return dt("{n} yr ago", { n: (days / 365).toFixed(1) });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function AiTools({
  onRecovered,
  onOpen,
}: {
  onRecovered: (bytes: number) => void;
  onOpen?: (view: string) => void;
}) {
  const [report, setReport] = useState<AiReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // Items ticked one by one; history that is picked by age lives in `cutoffs`.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cutoffs, setCutoffs] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [outcome, setOutcome] = useState<AiRemoveOutcome | null>(null);
  const activeToken = useRef<string | null>(null);

  const items = useMemo(() => report?.tools.flatMap((t) => t.items) ?? [], [report]);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const r = await invoke<AiReport>("ai_tools_scan");
      setReport(r);
      setSelected(
        new Set(r.tools.flatMap((t) => t.items).filter((i) => i.preselect).map((i) => i.id))
      );
      setCutoffs({});
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan();
    let unlisten: UnlistenFn | undefined;
    listen<Progress & { token: string }>("ai-tools-progress", (event) => {
      if (event.payload.token !== activeToken.current) return;
      setProgress(event.payload);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const aged = (i: AiItem) => i.ages.length > 0;
  const bucket = (i: AiItem) => i.ages.find((b) => b.days === cutoffs[i.id]);
  const isSelected = (i: AiItem) => (aged(i) ? bucket(i) != null : selected.has(i.id));
  // Whole folders are held back while their tool runs; old sessions are not.
  const blocked = (i: AiItem) => !i.removable || (i.tool_running && !aged(i));

  const toggle = (i: AiItem) => {
    if (blocked(i)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i.id)) next.delete(i.id);
      else next.add(i.id);
      return next;
    });
  };

  const pickAge = (i: AiItem, days: string) => {
    setCutoffs((prev) => {
      const next = { ...prev };
      if (days === "") delete next[i.id];
      else next[i.id] = Number(days);
      return next;
    });
  };

  const chosen = items.filter((i) => i.removable && isSelected(i));
  const bytesOf = (i: AiItem) => (aged(i) ? (bucket(i)?.bytes ?? 0) : i.size_bytes);
  const chosenBytes = chosen.reduce((a, i) => a + bytesOf(i), 0);
  const chosenHistory = chosen.filter((i) => i.safety === "risky");

  const selectSafe = () =>
    setSelected(
      new Set(items.filter((i) => i.removable && i.safety === "safe" && !blocked(i)).map((i) => i.id))
    );
  const clearSelection = () => {
    setSelected(new Set());
    setCutoffs({});
  };

  const removeSelected = async () => {
    setConfirming(false);
    setOutcome(null);
    setError(null);
    const token = `ai:${Math.random()}`;
    activeToken.current = token;
    setCancelling(false);
    setProgress({ done: 0, total: chosen.length, current: "", step_done: 0, step_total: 0 });
    try {
      const result = await invoke<AiRemoveOutcome>("remove_ai_leftovers", {
        items: chosen.map((i) => ({
          path: i.id,
          older_than_days: aged(i) ? cutoffs[i.id] : null,
          expected: i.safety,
        })),
        token,
      });
      setOutcome(result);
      if (result.errors.length) setError(result.errors.join("; "));
      onRecovered(result.freed_bytes);
      await scan();
    } catch (e) {
      setError(String(e));
    } finally {
      activeToken.current = null;
      setProgress(null);
      setCancelling(false);
    }
  };

  const cancel = () => {
    if (!activeToken.current) return;
    setCancelling(true);
    invoke("cancel_ai_removal", { token: activeToken.current }).catch(() => {});
  };

  const visible = (list: AiItem[]) =>
    filter === "all"
      ? list
      : filter === "history"
        ? list.filter((i) => i.safety === "risky")
        : list.filter((i) => i.safety !== "risky" && i.class !== "link");

  const clearableCount = items.filter((i) => i.safety !== "risky" && i.class !== "link").length;
  const historyCount = items.filter((i) => i.safety === "risky").length;
  const busy = progress != null;

  return (
    <>
      {confirming && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{dt("Move")}{dt(" ")}{plural(chosen.length, dt("item"), dt("items"))}{dt(" ")}{dt("to the")}{dt(" ")}{dt(BIN)}?
            </h3>
            <p className="modal-body">{dt("Caches, logs and downloads are rebuilt by their tool the next time it runs. Every item is checked again just before it moves, and anything a running tool may be using stays where it is.")}</p>
            {chosenHistory.length > 0 && (
              <>
                <p className="modal-warn">
                  {plural(chosenHistory.length, dt("of these holds"), dt("of these hold"))}{dt(" ")}{dt("your conversation history, saved state or extensions. Env-Tools cannot re-create them, and nothing else keeps a copy. They stay in the")}{dt(" ")}{dt(BIN)}{dt(" ")}{dt("until you empty it.")}</p>
                <label className="ai-ack">
                  <input
                    type="checkbox"
                    checked={understood}
                    onChange={(e) => setUnderstood(e.target.checked)}
                  />
                  <span>{dt("I understand this history cannot be re-created.")}</span>
                </label>
              </>
            )}
            <ul className="ai-confirm-list">
              {chosen.slice(0, 8).map((i) => (
                <li key={i.id}>
                  <span>
                    {i.label}
                    {aged(i) && cutoffs[i.id] ? dt(", older than {p0} days", { p0: cutoffs[i.id] }) : dt("")}
                  </span>
                  <span>{formatBytes(bytesOf(i))}</span>
                </li>
              ))}
              {chosen.length > 8 && <li>{dt("and")}{dt(" ")}{chosen.length - 8}{dt(" ")}{dt("more")}</li>}
            </ul>
            <div className="modal-total">
              <span>{dt("Space reclaimed")}</span>
              <strong>{formatBytes(chosenBytes)}</strong>
            </div>
            <p className="modal-foot">{dt("Everything moves to the")}{dt(" ")}{dt(BIN)}{dt(", so you can put it back until you empty it.")}</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirming(false)}>{dt("No, keep it")}</button>
              <button
                className="btn-danger"
                onClick={removeSelected}
                disabled={chosenHistory.length > 0 && !understood}
              >{dt("Yes, move to")}{dt(" ")}{dt(BIN)}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("AI tools")}</h2>
          <p className="view-sub">{dt("What Claude Code, Codex, Cursor, Windsurf, Copilot, Continue and Aider leave behind — caches to clear, history to keep or trim")}</p>
        </div>
        <button className="btn" onClick={scan} disabled={scanning || busy}>
          {scanning ? dt("Scanning…") : dt("Rescan")}
        </button>
      </div>

      {error && (
        <div className="banner-error">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      {progress && (
        <div className="banner-info ai-progress">
          <div className="meter-head">
            <span>{dt("Moving to the")}{dt(" ")}{dt(BIN)}
              {progress.current && dt(" · {p0}", { p0: progress.current })}
              {progress.step_total > 0 && dt(" ({p0} of {p1} entries)", { p0: progress.step_done, p1: progress.step_total })}
            </span>
            <span className="meter-value">
              {Math.min(progress.done, progress.total)}{dt(" ")}{dt("of")}{dt(" ")}{progress.total}
            </span>
          </div>
          <div className="meter-track">
            <div
              className="meter-fill"
              style={{
                width: `${Math.max(3, (progress.done / (progress.total || 1)) * 100)}%`,
                background: "var(--accent)",
              }}
            />
          </div>
          <div className="ai-progress-actions">
            <p className="model-meta">{dt("Large folders can take a while on")}{dt(" ")}{isWindows ? dt("Windows") : dt("this disk")}{dt(". You can keep using Env-Tools in the meantime.")}</p>
            <button className="btn" onClick={cancel} disabled={cancelling}>
              {cancelling ? dt("Stopping after this batch…") : dt("Cancel")}
            </button>
          </div>
        </div>
      )}

      {outcome && !progress && (
        <div className="banner-info">
          {outcome.moved > 0 && (
            <>{dt("Moved")}{dt(" ")}{plural(outcome.moved, dt("entry"), dt("entries"))}{dt(" ")}{dt("to the")}{dt(" ")}{dt(BIN)} (
              {formatBytes(outcome.freed_bytes)}).{dt(" ")}
            </>
          )}
          {outcome.cancelled && <>{dt("Stopped early, as you asked; the rest was not touched.")}</>}
          {outcome.already_gone.length > 0 && (
            <>{plural(outcome.already_gone.length, dt("location was"), dt("locations were"))}{dt(" ")}{dt("already empty.")}</>
          )}
          {outcome.skipped.length > 0 && (
            <>{dt("Left in place (")}{outcome.skipped.length}):
              <ul className="ai-skipped">
                {outcome.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {outcome.moved === 0 &&
            outcome.skipped.length === 0 &&
            !outcome.cancelled &&
            dt("Nothing needed moving.")}
        </div>
      )}

      {scanning && !report && (
        <div className="empty-state">
          <div className="spinner" />
          <p>{dt("Looking through each tool's folders and measuring what they hold…")}</p>
        </div>
      )}

      {report && (
        <>
          <section className="metrics">
            <div className="metric">
              <span className="metric-label">{dt("Found")}</span>
              <span className="metric-value">{formatBytes(report.total_bytes)}</span>
            </div>
            <div className="metric accent">
              <span className="metric-label">{dt("Safe to clear now")}</span>
              <span className="metric-value">{formatBytes(report.safe_bytes)}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("History and settings")}</span>
              <span className="metric-value">{formatBytes(report.history_bytes)}</span>
            </div>
          </section>

          <div className="banner-info">{dt("AI coding tools keep two kinds of data side by side.")}{dt(" ")}<strong>{dt("Caches and logs")}</strong>{dt(" ")}{dt("are rebuilt by the tool and are safe to clear once it is closed.")}{dt(" ")}
            <strong>{dt("Conversation history, memory, settings and extensions")}</strong>{dt(" ")}{dt("cannot be re-created, so they are listed with their size and age but never selected for you. Old sessions can be trimmed by age; today's are never touched.")}</div>

          <div className="filter-row">
            <div className="filter-tabs">
              <button
                className={`filter-tab ${filter === "all" ? "is-active" : ""}`}
                onClick={() => setFilter("all")}
              >{dt("All (")}{items.length})
              </button>
              <button
                className={`filter-tab ${filter === "clearable" ? "is-active" : ""}`}
                onClick={() => setFilter("clearable")}
              >{dt("Caches and downloads (")}{clearableCount})
              </button>
              <button
                className={`filter-tab ${filter === "history" ? "is-active" : ""}`}
                onClick={() => setFilter("history")}
              >{dt("History and settings (")}{historyCount})
              </button>
            </div>
            <div className="confirm">
              <button className="btn-ghost" onClick={selectSafe} disabled={busy}>{dt("Select all safe")}</button>
              <button className="btn-ghost" onClick={clearSelection} disabled={busy || chosen.length === 0}>{dt("Clear selection")}</button>
              {chosen.length > 0 && (
                <button
                  className="btn-clean"
                  disabled={busy}
                  onClick={() => {
                    setUnderstood(false);
                    setConfirming(true);
                  }}
                >{dt("Remove")}{dt(" ")}{chosen.length}{dt(" ")}{dt("selected (")}{formatBytes(chosenBytes)})
                </button>
              )}
            </div>
          </div>

          {report.tools.length === 0 && (
            <div className="empty-state">
              <p>{dt("No AI coding tool data found on this computer.")}</p>
            </div>
          )}

          {report.tools.map((tool) => {
            const shown = visible(tool.items);
            if (shown.length === 0) return null;
            const open = expanded.has(tool.id);
            const rows = open ? shown : shown.slice(0, COLLAPSED_ROWS);
            return (
              <section key={tool.id}>
                <div className="ai-tool-head">
                  <h2 className="section-title">
                    {tool.name} <span className="count">{tool.items.length}</span>
                  </h2>
                  <span className="ai-tool-size">{formatBytes(tool.total_bytes)}</span>
                  {tool.running.length > 0 && (
                    <span className="ai-running" title={dt("Caches are held back while the tool runs")}>{dt("running now")}</span>
                  )}
                </div>
                {tool.worktrees_link && onOpen && (
                  <p className="view-sub ai-tool-note">{dt("Spare git checkouts this tool makes are handled by the Git worktrees tab, which asks git whether each one is merged.")}{dt(" ")}<button className="btn-ghost sm" onClick={() => onOpen("worktrees")}>{dt("Open Git worktrees")}</button>
                  </p>
                )}
                <div className="findings">
                  {rows.map((i) => (
                    <label key={i.id} className={`model-row ai-row ${blocked(i) && !aged(i) ? "is-locked" : ""}`}>
                      {aged(i) && i.removable ? (
                        <div className="ai-pick">
                          <select
                            value={cutoffs[i.id] ?? ""}
                            disabled={busy}
                            onChange={(e) => pickAge(i, e.target.value)}
                            aria-label={dt("Move {p0} older than", { p0: i.label })}
                          >
                            <option value="">{dt("Keep all")}</option>
                            {i.ages.map((b) => (
                              <option key={b.days} value={b.days} disabled={b.files === 0}>{dt("Older than")}{dt(" ")}{b.days}{dt(" ")}{dt("days (")}{formatBytes(b.bytes)})
                              </option>
                            ))}
                          </select>
                          <span>
                            {cutoffs[i.id]
                              ? dt("{p0} selected", { p0: plural(bucket(i)?.files ?? 0, "file", "files") })
                              : dt("Choose an age to select")}
                          </span>
                        </div>
                      ) : (
                        <input
                          type="checkbox"
                          checked={isSelected(i)}
                          disabled={blocked(i) || busy}
                          onChange={() => toggle(i)}
                          title={
                            !i.removable
                              ? dt("Env-Tools only lists this one")
                              : i.tool_running
                                ? dt("The tool is running; close it first")
                                : undefined
                          }
                        />
                      )}
                      <div className="model-main">
                        <div className="finding-title">
                          <span className="finding-name">{i.label}</span>
                          <span className={`badge safety-${i.safety}`}>{dt(SAFETY_LABEL[i.safety])}</span>
                          <span className="badge cat-dev_cache">{dt(CLASS_LABEL[i.class])}</span>
                          {!i.removable && i.class !== "link" && <span className="badge safety-caution">{dt("Listed only")}</span>}
                        </div>
                        <span className="model-meta">
                          {plural(i.file_count, dt("file"), dt("files"))}
                          {i.modified_days != null && dt(" · last changed {p0}", { p0: ageLabel(i.modified_days) })}
                          {i.paths.length > 1 && dt(" · {p0} folders", { p0: i.paths.length })}
                        </span>
                        <code className="finding-path">{i.path}</code>
                        <p className="ai-explain">{i.explanation}</p>
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
                        {i.link && onOpen && (
                          <div>
                            <button
                              className="btn-ghost sm"
                              onClick={(e) => {
                                e.preventDefault();
                                onOpen(i.link as string);
                              }}
                            >{dt("Open Git worktrees")}</button>
                          </div>
                        )}
                      </div>
                      <div className="finding-size">
                        <span className="size">{formatBytes(i.size_bytes)}</span>
                      </div>
                      <button
                        className="btn-ghost sm"
                        onClick={(e) => {
                          e.preventDefault();
                          invoke("reveal_path", { path: i.path }).catch((err) => setError(String(err)));
                        }}
                      >{dt("Show")}</button>
                    </label>
                  ))}
                  {shown.length > COLLAPSED_ROWS && (
                    <button
                      className="ai-more"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(tool.id)) next.delete(tool.id);
                          else next.add(tool.id);
                          return next;
                        })
                      }
                    >
                      {open ? dt("Show fewer") : dt("Show {p0} more", { p0: shown.length - COLLAPSED_ROWS })}
                    </button>
                  )}
                </div>
              </section>
            );
          })}

          <p className="footnote">{dt("Only locations Env-Tools knows are listed; anything it does not recognise is left out rather than guessed at. Editor storage for projects that still exist, and Aider's files inside your projects, are listed but never removed here. Claude's desktop app keeps its sign-in and settings in the same data folder as its caches: Env-Tools clears only the cache and log folders inside it, like the app's own Clear Cache.")}</p>
        </>
      )}
    </>
  );
}
