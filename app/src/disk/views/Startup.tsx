import { useEffect, useMemo, useState } from "react";
import { invoke } from "../adapter";
import { formatBytes, isWindows } from "../format";
import type { Reason, Safety } from "../types";
import { dt, useLang } from "../i18n";

type ImpactLevel = "none" | "low" | "medium" | "high" | "unknown";

interface StartupEntry {
  id: string;
  name: string;
  description: string | null;
  publisher: string | null;
  command: string;
  target: string | null;
  target_exists: boolean | null;
  kind: string;
  kind_label: string;
  scope: "user" | "machine";
  location: string;
  enabled: boolean | null;
  disabled_at: number | null;
  can_toggle: boolean;
  needs_admin: boolean;
  read_only_note: string | null;
  size_bytes: number | null;
  running: boolean;
  memory_bytes: number | null;
  impact: { level: ImpactLevel; text: string };
  safety: Safety;
  summary: string;
  reasons: Reason[];
}

interface StartupReport {
  supported: boolean;
  elevated: boolean;
  entries: StartupEntry[];
  hidden_system_tasks: number;
  notes: string[];
}

interface StartupOutcome {
  changed: string[];
  skipped: { id: string; name: string; why: string }[];
  admin_declined: boolean;
  errors: string[];
}

type Filter = "all" | "on" | "off" | "missing" | "listed";

const IMPACT_BADGE: Record<ImpactLevel, string> = {
  high: "safety-risky",
  medium: "safety-caution",
  low: "",
  none: "",
  unknown: "",
};

const IMPACT_LABEL: Record<ImpactLevel, string> = {
  high: "High impact",
  medium: "Medium impact",
  low: "Low impact",
  none: "No impact",
  unknown: "Impact unknown",
};

function dateLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export default function Startup() {
  useLang();
  const [report, setReport] = useState<StartupReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ enable: boolean; result: StartupOutcome } | null>(null);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const r = await invoke<StartupReport>("startup_scan");
      setReport(r);
      // Only entries whose program is gone are preselected.
      setSelected(
        new Set(
          r.entries
            .filter((e) => e.can_toggle && e.enabled !== false && e.safety === "safe")
            .map((e) => e.id)
        )
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan();
  }, []);

  const entries = report?.entries ?? [];
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const switchable = (e: StartupEntry, enable: boolean) =>
    e.can_toggle && (enable ? e.enabled !== true : e.enabled !== false && e.safety !== "risky");

  const apply = async (ids: string[], enable: boolean) => {
    setConfirming(false);
    setOutcome(null);
    setError(null);
    const needsAdmin = ids.some((id) => byId.get(id)?.needs_admin);
    setBusy(
      needsAdmin
        ? dt("Waiting for the Windows permission prompt…")
        : enable
          ? dt("Turning on…")
          : dt("Turning off…")
    );
    try {
      const result = await invoke<StartupOutcome>("set_startup_enabled", { ids, enable });
      setOutcome({ enable, result });
      if (result.errors.length) setError(result.errors.join("; "));
      await scan();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedEntries = entries.filter((e) => selected.has(e.id) && switchable(e, false));
  const adminCount = selectedEntries.filter((e) => e.needs_admin).length;

  const shown = entries.filter((e) => {
    switch (filter) {
      case "on":
        return e.enabled !== false;
      case "off":
        return e.enabled === false;
      case "missing":
        return e.target_exists === false;
      case "listed":
        return !e.can_toggle;
      default:
        return true;
    }
  });

  const onCount = entries.filter((e) => e.enabled !== false).length;
  const offCount = entries.filter((e) => e.enabled === false).length;
  const missingCount = entries.filter((e) => e.target_exists === false).length;
  const listedCount = entries.filter((e) => !e.can_toggle).length;
  const heavyCount = entries.filter(
    (e) => e.enabled !== false && (e.impact.level === "high" || e.impact.level === "medium")
  ).length;

  return (
    <>
      {confirming && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">
              {dt("Turn off {n} startup apps?", { n: selectedEntries.length })}
            </h3>
            <p className="modal-body">
              {dt("They will not start the next time you sign in. Nothing is deleted and nothing running is closed: Env-Tools only switches the same on/off flag Task Manager uses, so they also show as Disabled there. Turn any of them back on from this tab, or in Task Manager.")}
            </p>
            {adminCount > 0 && (
              <p className="modal-body">
                {dt("{n} of them start for everyone on this computer, so Windows will ask for administrator permission once. Env-Tools itself keeps running without it.", { n: adminCount })}
              </p>
            )}
            <div className="modal-items">
              {selectedEntries.slice(0, 4).map((e) => (
                <code key={e.id} className="modal-item">{e.name}</code>
              ))}
              {selectedEntries.length > 4 && (
                <span className="modal-more">{dt("and {n} more", { n: selectedEntries.length - 4 })}</span>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy != null}>
                {dt("No, leave them")}
              </button>
              <button
                className="btn-danger"
                onClick={() => apply(selectedEntries.map((e) => e.id), false)}
                disabled={busy != null}
              >
                {busy ?? dt("Yes, turn off")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Startup apps")}</h2>
          <p className="view-sub">
            {dt("What starts by itself when you sign in — turn off what you do not need, and turn it back on whenever you like")}
          </p>
        </div>
        <button className="btn" onClick={scan} disabled={scanning || busy != null}>
          {dt(scanning ? "Scanning…" : "Rescan")}
        </button>
      </div>

      {error && (
        <div className="banner-error">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      {busy && <div className="banner-info">{busy}</div>}

      {outcome && !busy && (
        <div className="banner-info">
          {outcome.result.changed.length > 0 && (
            <>
              {dt(outcome.enable ? "Turned on {n} apps. It takes effect at your next sign-in." : "Turned off {n} apps. It takes effect at your next sign-in.", { n: outcome.result.changed.length })}{dt(" ")}
              <button
                className="btn-ghost sm su-undo"
                onClick={() => apply(outcome.result.changed, !outcome.enable)}
              >
                {dt("Undo")}
              </button>{dt(" ")}
            </>
          )}
          {outcome.result.admin_declined && (
            <>{dt("Windows asked for administrator permission and it was declined, so nothing machine-wide was changed.")} </>
          )}
          {outcome.result.skipped.length > 0 && (
            <>
              {dt("Skipped {n}:", { n: outcome.result.skipped.length })}
              <ul className="wt-reasons">
                {outcome.result.skipped.map((s) => (
                  <li key={s.id}>
                    {s.name}: {s.why}
                  </li>
                ))}
              </ul>
            </>
          )}
          {outcome.result.changed.length === 0 &&
            outcome.result.skipped.length === 0 &&
            !outcome.result.admin_declined &&
            dt("Nothing was changed.")}
        </div>
      )}

      {scanning && !report && (
        <div className="empty-state">
          <div className="spinner" />
          <p>{dt("Reading startup entries, shortcuts and scheduled tasks…")}</p>
        </div>
      )}

      {report && !report.supported && (
        <div className="banner-info">{dt("Startup apps are only listed on Windows and macOS.")}</div>
      )}

      {report && report.supported && (
        <>
          <section className="metrics">
            <div className="metric">
              <span className="metric-label">{dt("Startup entries")}</span>
              <span className="metric-value">{entries.length}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("On at sign-in")}</span>
              <span className="metric-value">{onCount}</span>
            </div>
            <div className="metric accent">
              <span className="metric-label">{dt("Likely heavy (estimated)")}</span>
              <span className="metric-value">{heavyCount}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("Program missing")}</span>
              <span className="metric-value">{missingCount}</span>
            </div>
          </section>

          <div className="banner-info">
            {dt("Impact is an estimate from the program's file size and whether it is running now (with the memory its processes use); Env-Tools does not measure real start-up time.")}{dt(" ")}
            {isWindows
              ? dt("Turning an entry off flips the same flag as Task Manager's Startup tab and never deletes the entry.")
              : dt("On macOS these are only listed; change them in System Settings, General, Login Items.")}
          </div>

          {report.notes.map((n) => (
            <div key={n} className="banner-info">{n}</div>
          ))}

          <div className="filter-row">
            <div className="filter-tabs">
              {(
                [
                  ["all", dt("All ({n})", { n: entries.length })],
                  ["on", dt("On ({n})", { n: onCount })],
                  ["off", dt("Off ({n})", { n: offCount })],
                  ["missing", dt("Missing program ({n})", { n: missingCount })],
                  ["listed", dt("Listed only ({n})", { n: listedCount })],
                ] as [Filter, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={`filter-tab ${filter === id ? "is-active" : ""}`}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="confirm">
              {selectedEntries.length > 0 && (
                <button className="btn-clean" disabled={busy != null} onClick={() => setConfirming(true)}>
                  {dt("Turn off {n} selected", { n: selectedEntries.length })}
                </button>
              )}
            </div>
          </div>

          {shown.length === 0 && (
            <div className="empty-state">
              <p>{dt("Nothing in this list.")}</p>
            </div>
          )}

          {shown.length > 0 && (
            <div className="findings">
              {shown.map((e) => {
                const off = e.enabled === false;
                const canOff = switchable(e, false);
                const canOn = switchable(e, true);
                return (
                  <div key={e.id} className={`model-row su-row ${off ? "is-off" : ""}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(e.id) && canOff}
                      disabled={!canOff || busy != null}
                      onChange={() => toggle(e.id)}
                      title={
                        canOff
                          ? undefined
                          : e.can_toggle && !off
                            ? dt("Env-Tools will not turn off protected software")
                            : (e.read_only_note ?? dt("Not available"))
                      }
                    />
                    <div className="model-main">
                      <div className="finding-title">
                        <span className="finding-name">{e.name}</span>
                        <span className={`badge safety-${e.safety}`}>{dt(e.summary)}</span>
                        <span className="badge cat-dev_cache">
                          {e.enabled === null ? dt("State unclear") : off ? dt("Off") : dt("On")}
                        </span>
                        <span className={`badge ${IMPACT_BADGE[e.impact.level]}`}>
                          {dt(IMPACT_LABEL[e.impact.level])}
                        </span>
                        {e.running && <span className="badge">{dt("Running now")}</span>}
                      </div>
                      <span className="su-publisher">
                        {e.publisher ?? dt("Publisher unknown")} · {e.kind_label} ·{dt(" ")}
                        {e.scope === "machine" ? dt("all users") : dt("this user")}
                        {e.size_bytes != null && dt(" · {p0}", { p0: dt("{size} on disk", { size: formatBytes(e.size_bytes) }) })}
                        {off && e.disabled_at != null && dt(" · {p0}", { p0: dt("turned off {date}", { date: dateLabel(e.disabled_at) }) })}
                      </span>
                      <code className="finding-path">{e.command || e.location}</code>
                      <p className="su-impact">{e.impact.text}</p>
                      <ul className="safety-reasons">
                        {e.reasons.map((r) => (
                          <li key={r.text} className={`reason-${r.level}`}>
                            <span className="reason-mark" aria-hidden>
                              {r.level === "ok" ? dt("✓") : r.level === "warn" ? dt("!") : dt("✕")}
                            </span>
                            {r.text}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="su-actions">
                      {canOff && (
                        <button
                          className="btn sm"
                          disabled={busy != null}
                          onClick={() => apply([e.id], false)}
                          title={e.needs_admin ? dt("Windows will ask for administrator permission") : undefined}
                        >
                          {dt("Turn off")}
                        </button>
                      )}
                      {canOn && (
                        <button
                          className="btn sm"
                          disabled={busy != null}
                          onClick={() => apply([e.id], true)}
                          title={e.needs_admin ? dt("Windows will ask for administrator permission") : undefined}
                        >
                          {dt("Turn on")}
                        </button>
                      )}
                      {!canOff && !canOn && (
                        <span className="su-note">
                          {e.can_toggle ? dt("Protected: Env-Tools will not turn this off") : e.read_only_note}
                        </span>
                      )}
                      {e.target && e.target_exists && (
                        <button
                          className="btn-ghost sm"
                          onClick={() =>
                            invoke("reveal_path", { path: e.target }).catch((err) => setError(String(err)))
                          }
                        >
                          {dt("Show")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="footnote">
            {report.hidden_system_tasks > 0 &&
              dt("{p0} ", { p0: dt("{n} Windows system tasks that run at sign-in are not listed.", { n: report.hidden_system_tasks }) })}
            {dt("Publisher names come from the program's file information, not a verified signature. Security software, hardware drivers and Windows components are never offered for turning off. Machine-wide entries need administrator permission; Windows asks once.")}
          </p>
        </>
      )}
    </>
  );
}
