import { useEffect, useState } from "react";
import { invoke } from "../adapter";
import { formatBytes, isWindows } from "../format";
import type { DriveInfo, Forecast, HealthReport } from "../types";
import ForecastNote from "../components/ForecastNote";
import { dt, useLang } from "../i18n";

function Donut({ pct }: { pct: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const color = pct >= 90 ? "var(--danger)" : pct >= 80 ? "#BA7517" : "var(--c-dev)";
  return (
    <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label={dt("{pct}% used", { pct: Math.round(pct) })}>
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="14" />
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="14"
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        transform="rotate(-90 70 70)"
      />
      <text x="70" y="66" textAnchor="middle" style={{ fontSize: 24, fontWeight: 600, fill: "var(--text)" }}>
        {Math.round(pct)}%
      </text>
      <text x="70" y="86" textAnchor="middle" style={{ fontSize: 12, fill: "var(--text-2)" }}>
        {dt("used")}
      </text>
    </svg>
  );
}

/// Usage over time with a dashed projection to the point the drive fills up.
function ForecastChart({ forecast, total }: { forecast: Forecast; total: number }) {
  const W = 520;
  const H = 150;
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 26;

  const pts = forecast.points;
  if (pts.length === 0) return null;

  const firstDay = pts[0].day;
  // With a single reading there is no span to draw across, so give the axis a
  // nominal week. The chart still shows the real point and fills in over time.
  const lastDay = Math.max(pts[pts.length - 1].day, firstDay + (pts.length < 2 ? 7 : 0));
  const daysAhead = forecast.days_until_full ?? 0;
  const spanDays = Math.max(1, lastDay - firstDay + Math.min(daysAhead, 400));

  const x = (day: number) => padL + ((day - firstDay) / spanDays) * (W - padL - padR);
  const y = (used: number) => padT + (1 - used / total) * (H - padT - padB);

  const line = pts.map((p) => `${x(p.day).toFixed(1)},${y(p.used).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];

  const projection =
    forecast.days_until_full != null
      ? `${x(last.day).toFixed(1)},${y(last.used).toFixed(1)} ${x(
          last.day + forecast.days_until_full
        ).toFixed(1)},${y(total).toFixed(1)}`
      : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
      aria-label={dt("Disk usage over {days} days{projection}", {
        days: lastDay - firstDay,
        projection: forecast.days_until_full != null ? dt(", projected full in {days} days", { days: forecast.days_until_full }) : "",
      })}
    >
      <line x1={padL} y1={y(total)} x2={W - padR} y2={y(total)} stroke="var(--border-strong, #c3c2b7)" strokeWidth="1" strokeDasharray="3 3" />
      <text x={padL} y={y(total) - 5} style={{ fontSize: 10, fill: "var(--text-3)" }}>
        {dt("Full · {size}", { size: formatBytes(total) })}
      </text>
      {projection && (
        <polyline points={projection} fill="none" stroke="#BA7517" strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round" />
      )}
      {pts.length >= 2 && (
        <polyline points={line} fill="none" stroke="var(--c-user)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      )}
      <circle cx={x(last.day)} cy={y(last.used)} r="4" fill="var(--c-user)" stroke="var(--surface)" strokeWidth="2" />
      <text x={padL} y={H - 8} style={{ fontSize: 10.5, fill: "var(--text-3)" }}>
        {pts.length === 1
          ? dt("First reading recorded today")
          : dt("{count} readings over {days} days", { count: pts.length, days: pts[pts.length - 1].day - firstDay })}
      </text>
    </svg>
  );
}

function Meter({ label, value, pct, tone }: { label: string; value: string; pct: number; tone: string }) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">{value}</span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(1, pct))}%`, background: tone }} />
      </div>
    </div>
  );
}

export default function DriveHealth() {
  useLang();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      setReport(await invoke<HealthReport>("drive_health"));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan();
  }, []);

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Drive health")}</h2>
          <p className="view-sub">{dt("Capacity, trend, and hardware status for every mounted drive")}</p>
        </div>
        <button className="btn" onClick={scan} disabled={scanning}>
          {dt(scanning ? "Checking…" : "Refresh")}
        </button>
      </div>

      {error && (
        <div className="banner-error">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}>{dt("Dismiss")}</button>
        </div>
      )}

      {scanning && !report && (
        <div className="empty-state"><div className="spinner" /><p>{dt("Reading drive information…")}</p></div>
      )}

      {report?.drives.map((d: DriveInfo) => {
        const used = d.total_bytes - d.available_bytes;
        const pct = d.total_bytes ? (used / d.total_bytes) * 100 : 0;
        const healthy = d.smart_status === "Verified";
        const failing = d.smart_status === "Failing" || d.smart_status === "Failed";
        const f = d.forecast;
        const sd = d.smart_detail;

        return (
          <div key={d.mount} className="health-card">
            <div className="health-top">
              <Donut pct={pct} />
              <div className="drive-info">
                <span className="finding-name">{d.name || d.mount}</span>
                <code className="finding-path">{d.mount}</code>
                <div className="drive-badges">
                  <span className="badge stale">{d.kind}</span>
                  <span className="badge stale">{d.file_system}</span>
                  {d.removable && <span className="badge stale">{dt("Removable")}</span>}
                  {d.smart_status && (
                    // "Not Supported" means the volume cannot report SMART, not
                    // that the drive is unhealthy — only a real failure is red.
                    <span
                      className={`badge ${
                        healthy ? "safety-safe" : failing ? "safety-risky" : "stale"
                      }`}
                    >{dt("SMART:")}{dt(" ")}{dt(d.smart_status)}
                    </span>
                  )}
                </div>
                <p className="drive-line">
                  <strong>{formatBytes(d.available_bytes)}</strong> {dt("free of {total}", { total: formatBytes(d.total_bytes) })}
                </p>
                {pct >= 90 && (
                  <p className="drive-warn">{dt("Nearly full — apps and updates may start failing.")}</p>
                )}
                {pct >= 80 && pct < 90 && (
                  <p className="drive-warn soft">{dt("Getting full — consider a cleanup pass.")}</p>
                )}
              </div>
            </div>

            <div className="health-panels">
              <div className="health-panel">
                <h3 className="section-title">{dt("Fill forecast")}</h3>
                {f && f.points.length > 0 ? (
                  <>
                    <ForecastChart forecast={f} total={d.total_bytes} />
                    <p className="forecast-note">
                      {f.days_until_full != null ? (
                        dt("Filling at about {size} per day — full in roughly {weeks} weeks.", {
                          size: formatBytes(Math.abs(f.bytes_per_day)), weeks: Math.round(f.days_until_full / 7),
                        })
                      ) : f.bytes_per_day < 0 ? (
                        dt("Free space is growing. No projection needed.")
                      ) : (
                        dt("One reading per day is recorded. After three days the line becomes a projection of when this drive fills up.")
                      )}
                    </p>
                  </>
                ) : (
                  <p className="view-sub">{dt("No readings recorded yet.")}</p>
                )}
                <ForecastNote mount={d.mount} />
              </div>

              <div className="health-panel">
                <h3 className="section-title">{dt("Hardware")}</h3>
                <div className="meters">
                  {/* Always available, so the panel is never empty. */}
                  <Meter
                    label={dt("Capacity used")}
                    value={`${Math.round(pct)}%`}
                    pct={pct}
                    tone={pct >= 90 ? "var(--danger)" : pct >= 80 ? "#BA7517" : "var(--c-dev)"}
                  />
                  <div className="meter-row">
                    <span>{dt("SMART self-check")}</span>
                    <span className={healthy ? "meter-good" : undefined}>
                      {dt(d.smart_status ?? "Not reported")}
                    </span>
                  </div>

                  {sd && (
                    <>
                      {sd.percentage_used != null && (
                      <Meter
                        label={dt("Drive wear used")}
                        value={`${sd.percentage_used}%`}
                        pct={sd.percentage_used}
                        tone={sd.percentage_used >= 80 ? "var(--danger)" : "var(--c-dev)"}
                      />
                    )}
                    {sd.temperature_c != null && (
                      <Meter
                        label={dt("Temperature")}
                        value={`${sd.temperature_c} °C`}
                        pct={(sd.temperature_c / 90) * 100}
                        tone={sd.temperature_c >= 70 ? "var(--danger)" : "var(--c-dev)"}
                      />
                    )}
                    {sd.reallocated_sectors != null && (
                      <div className="meter-row">
                        <span>{dt("Reallocated sectors")}</span>
                        <span className={sd.reallocated_sectors > 0 ? "meter-bad" : "meter-good"}>
                          {sd.reallocated_sectors === 0
                            ? dt("0 · healthy")
                            : dt("{n} · watch this", { n: sd.reallocated_sectors })}
                        </span>
                      </div>
                    )}
                    {sd.power_on_hours != null && (
                      <div className="meter-row">
                        <span>{dt("Power-on time")}</span>
                        <span>{dt("{n} hours", { n: sd.power_on_hours.toLocaleString() })}</span>
                      </div>
                    )}
                    </>
                  )}
                </div>

                {!sd && (
                  <p className="footnote left" style={{ marginTop: 10 }}>
                    {report.smart_tool_available
                      ? dt("This drive does not expose wear or temperature to smartctl.")
                      : isWindows
                        ? dt("Wear level, temperature, and power-on hours are not read on Windows yet — capacity and the fill forecast above are still accurate.")
                        : dt("Wear level, temperature, and power-on hours need smartmontools — install it with brew install smartmontools, then refresh.")}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
