import { useEffect, useState } from "react";
import { invoke } from "../adapter";
import { formatBytes } from "../format";
import ConfirmClean from "../components/ConfirmClean";
import type { CleanOutcome, DesktopReport, MoveOutcome } from "../types";
import { dt, useLang } from "../i18n";

type AgeFilter = "all" | "30" | "90";
type TypeFilter = "all" | "screenshots" | "other";

export default function Desktop({ onRecovered }: { onRecovered: (bytes: number) => void }) {
  useLang();
  const [report, setReport] = useState<DesktopReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [age, setAge] = useState<AgeFilter>("all");
  const [type, setType] = useState<TypeFilter>("screenshots");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [working, setWorking] = useState(false);

  const scan = async () => {
    setScanning(true);
    setError(null);
    setSelected(new Set());
    try {
      setReport(await invoke<DesktopReport>("desktop_scan"));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan();
  }, []);

  const shots = (report?.items ?? []).filter((i) => {
    if (type === "screenshots" && !i.is_screenshot) return false;
    if (type === "other" && i.is_screenshot) return false;
    if (age === "all") return true;
    return (i.age_days ?? 0) >= Number(age);
  });

  const otherCount = (report?.items ?? []).filter((i) => !i.is_screenshot).length;

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectedItems = (report?.items ?? []).filter((i) => selected.has(i.path));
  const selectedBytes = selectedItems.reduce((a, i) => a + i.size_bytes, 0);

  const archive = async () => {
    if (!report) return;
    setWorking(true);
    try {
      const outcome = await invoke<MoveOutcome>("move_to_folder", {
        paths: [...selected],
        destination: report.suggested_archive,
      });
      if (outcome.errors.length) setError(outcome.errors.join("; "));
      setNotice(dt("Moved {n} file(s) — {size} — to {path}", {
        n: outcome.moved, size: formatBytes(outcome.moved_bytes), path: report.suggested_archive,
      }));
      await scan();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  const trash = async () => {
    setWorking(true);
    setConfirmTrash(false);
    try {
      const outcome = await invoke<CleanOutcome>("clean_paths", { paths: [...selected], source: "Desktop" });
      if (outcome.errors.length) setError(outcome.errors.join("; "));
      onRecovered(outcome.freed_bytes);
      await scan();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      {confirmTrash && (
        <ConfirmClean
          request={{
            kind: "userfile",
            title: dt(selectedItems.length === 1 ? "Move {n} file to the Trash?" : "Move {n} files to the Trash?", { n: selectedItems.length }),
            items: selectedItems.map((i) => i.name),
            bytes: selectedBytes,
            risky: selectedItems.some((i) => !i.is_screenshot),
          }}
          busy={working}
          onConfirm={trash}
          onCancel={() => setConfirmTrash(false)}
        />
      )}

      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Desktop")}</h2>
          <p className="view-sub">{dt("Screenshots and clutter piling up on your desktop")}</p>
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
      {notice && (
        <div className="banner-info">
          <span>{notice}</span>{dt(" ")}
          <button className="btn-ghost" onClick={() => setNotice(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      {scanning && !report && (
        <div className="empty-state"><div className="spinner" /><p>{dt("Reading your desktop…")}</p></div>
      )}

      {report && (
        <>
          <section className="metrics">
            <div className="metric accent">
              <span className="metric-label">{dt("Screenshots")}</span>
              <span className="metric-value">{formatBytes(report.screenshot_bytes)}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("Screenshot files")}</span>
              <span className="metric-value">{report.screenshot_count}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("Everything on desktop")}</span>
              <span className="metric-value">{formatBytes(report.total_bytes)}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("Items")}</span>
              <span className="metric-value">{report.file_count}</span>
            </div>
          </section>

          <div className="banner-info">
            {dt("Screenshots are your own files, so archiving is the default — they move to {path} where you can still find them. Trashing is available when you are sure.", { path: report.suggested_archive })}
          </div>

          <div className="filter-row">
            <div className="filter-tabs">
              <button
                className={`filter-tab ${type === "screenshots" ? "is-active" : ""}`}
                onClick={() => setType("screenshots")}
              >
                {dt("Screenshots ({n})", { n: report.screenshot_count })}
              </button>
              <button
                className={`filter-tab ${type === "other" ? "is-active" : ""}`}
                onClick={() => setType("other")}
              >
                {dt("Other files ({n})", { n: otherCount })}
              </button>
              <button
                className={`filter-tab ${type === "all" ? "is-active" : ""}`}
                onClick={() => setType("all")}
              >
                {dt("All ({n})", { n: report.file_count })}
              </button>
            </div>
            <div className="filter-tabs">
              {(["all", "30", "90"] as AgeFilter[]).map((a) => (
                <button
                  key={a}
                  className={`filter-tab ${age === a ? "is-active" : ""}`}
                  onClick={() => setAge(a)}
                >
                  {dt(a === "all" ? "Any age" : "Older than {n}d", { n: a })}
                </button>
              ))}
            </div>
            <div className="confirm">
              <button
                className="btn-ghost"
                onClick={() => setSelected(new Set(shots.map((i) => i.path)))}
              >
                {dt("Select all shown")}
              </button>
              {selected.size > 0 && (
                <>
                  <button className="btn" onClick={archive} disabled={working}>
                    {dt(working ? "Working…" : "Archive {n} ({size})", { n: selected.size, size: formatBytes(selectedBytes) })}
                  </button>
                  <button className="btn-clean" onClick={() => setConfirmTrash(true)}>
                    {dt("Trash")}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="findings">
            {shots.length === 0 && (
              <div className="empty-state"><p>{dt("No screenshots in this view.")}</p></div>
            )}
            {shots.map((i) => (
              <label key={i.path} className="model-row">
                <input
                  type="checkbox"
                  checked={selected.has(i.path)}
                  onChange={() => toggle(i.path)}
                />
                <div className="model-main">
                  <span className="finding-name">{i.name}</span>
                  <span className="model-meta">
                    {i.age_days != null
                      ? dt(i.age_days < 1 ? "Today" : "{n} days old", { n: i.age_days })
                      : dt("Unknown date")}
                  </span>
                </div>
                <div className="finding-size">
                  <span className="size">{formatBytes(i.size_bytes)}</span>
                </div>
                <button
                  className="btn-ghost sm"
                  onClick={(e) => {
                    e.preventDefault();
                    invoke("reveal_path", { path: i.path }).catch(() => {});
                  }}
                >
                  {dt("Show")}
                </button>
              </label>
            ))}
          </div>
        </>
      )}
    </>
  );
}
