import { useEffect, useState } from "react";
import { invoke } from "../adapter";
import { formatBytes } from "../format";
import ConfirmClean from "../components/ConfirmClean";
import type { CleanOutcome, PyEnv, PyReport } from "../types";
import { dt, useLang } from "../i18n";

export default function Python({ onRecovered }: { onRecovered: (bytes: number) => void }) {
  useLang();
  const [report, setReport] = useState<PyReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PyEnv | null>(null);
  const [working, setWorking] = useState(false);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      setReport(await invoke<PyReport>("python_scan"));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan();
  }, []);

  const removeEnv = async (path: string) => {
    setWorking(true);
    setConfirming(null);
    try {
      const outcome = await invoke<CleanOutcome>("clean_paths", { paths: [path], source: "Python" });
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
      {confirming && (
        <ConfirmClean
          request={{
            kind: "environment",
            title: dt("Remove the {name} environment?", { name: confirming.name }),
            items: [confirming.path],
            bytes: confirming.size_bytes,
            risky: confirming.stale_days == null || confirming.stale_days < 90,
          }}
          busy={working}
          onConfirm={() => removeEnv(confirming.path)}
          onCancel={() => setConfirming(null)}
        />
      )}

      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Python environments")}</h2>
          <p className="view-sub">{dt("Where your virtualenvs and conda environments go, and what they duplicate")}</p>
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

      {scanning && !report && (
        <div className="empty-state">
          <div className="spinner" />
          <p>{dt("Looking for environments and measuring their packages…")}</p>
        </div>
      )}

      {report && (
        <>
          <section className="metrics">
            <div className="metric">
              <span className="metric-label">{dt("All environments")}</span>
              <span className="metric-value">{formatBytes(report.total_bytes)}</span>
            </div>
            <div className="metric accent">
              <span className="metric-label">{dt("Wasted on duplicates")}</span>
              <span className="metric-value">{formatBytes(report.wasted_bytes)}</span>
            </div>
            <div className="metric">
              <span className="metric-label">{dt("Environments")}</span>
              <span className="metric-value">{report.envs.length}</span>
            </div>
          </section>

          {report.duplicates.length > 0 && (
            <section>
              <h2 className="section-title">{dt("Packages installed in more than one environment")}</h2>
              <div className="findings">
                {report.duplicates.slice(0, 12).map((d) => (
                  <div key={d.name} className="dup-row">
                    <span className="finding-name">{d.name}</span>
                    <span className="badge stale">{dt("{n} copies", { n: d.copies })}</span>
                    <div className="child-bar">
                      <div
                        className="child-fill"
                        style={{
                          width: `${Math.max(
                            2,
                            (d.wasted_bytes / (report.duplicates[0]?.wasted_bytes || 1)) * 100
                          )}%`,
                        }}
                      />
                    </div>
                    <span className="child-size">{dt("{size} total", { size: formatBytes(d.total_bytes) })}</span>
                    <span className="dup-waste">{dt("{size} duplicated", { size: formatBytes(d.wasted_bytes) })}</span>
                  </div>
                ))}
              </div>
              <p className="footnote">{dt("Duplicated size is what you would save if each package existed only once. Removing an environment you no longer use is the safe way to reclaim it.")}</p>
            </section>
          )}

          <section>
            <h2 className="section-title">
              {dt("Environments")} <span className="count">{report.envs.length}</span>
            </h2>
            <div className="findings">
              {report.envs.length === 0 && (
                <div className="empty-state"><p>{dt("No Python environments found.")}</p></div>
              )}
              {report.envs.map((env) => (
                <div key={env.path} className="finding">
                  <div className="finding-row">
                    <button
                      className="expander"
                      onClick={() => setExpanded(expanded === env.path ? null : env.path)}
                      aria-label={dt("Toggle packages")}
                    >
                      {expanded === env.path ? dt("▾") : dt("▸")}
                    </button>
                    <div className="finding-main">
                      <div className="finding-title">
                        <span className="finding-name">{env.name}</span>
                        <span className="badge cat-dev_cache">{env.kind}</span>
                        {env.stale_days != null && env.stale_days > 90 && (
                          <span className="badge safety-caution">{dt("Untouched {n} mo", { n: Math.round(env.stale_days / 30) })}</span>
                        )}
                      </div>
                      <code className="finding-path">{env.path}</code>
                    </div>
                    <div className="finding-size">
                      <span className="size">{formatBytes(env.size_bytes)}</span>
                      <span className="files">{dt("{n} packages", { n: env.packages.length })}</span>
                    </div>
                    <div className="finding-actions">
                      <button
                        className="btn-ghost"
                        onClick={() => invoke("reveal_path", { path: env.path }).catch(() => {})}
                      >
                        {dt("Explore")}
                      </button>
                      <button className="btn-clean" onClick={() => setConfirming(env)}>
                        {dt("Remove")}
                      </button>
                    </div>
                  </div>
                  {expanded === env.path && (
                    <div className="finding-detail">
                      <div className="children">
                        {env.packages.map((p) => (
                          <div key={p.path} className="child">
                            <span className="child-name">{p.name}</span>
                            <div className="child-bar">
                              <div
                                className="child-fill"
                                style={{
                                  width: `${Math.max(
                                    1,
                                    (p.size_bytes / (env.packages[0]?.size_bytes || 1)) * 100
                                  )}%`,
                                }}
                              />
                            </div>
                            <span className="child-size">{formatBytes(p.size_bytes)}</span>
                            <span />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
