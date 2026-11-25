import { useEffect, useMemo, useState } from "react";
import { invoke } from "../adapter";
import { formatBytes, isWindows } from "../format";
import { squarify } from "../components/squarify";
import { dt, useLang } from "../i18n";

const BIN = isWindows ? "Recycle Bin" : "Trash";

interface DriveCard {
  mount: string;
  total: number;
  used: number;
  free: number;
  removable: boolean;
  system: boolean;
  days_until_full: number | null;
  forecast: string;
  trend: number[];
}

interface Batch {
  label: string;
  source: string;
  bytes: number;
  items: number;
  time: number;
}

interface Folder {
  name: string;
  path: string;
  bytes: number;
}

interface Quick {
  drives: DriveCard[];
  saved_total: number;
  saved_items: number;
  saved_since: number | null;
  saved_weeks: number[];
  recent: Batch[];
  system_map: { root: string; ts: number; folders: Folder[]; other: number } | null;
  prefs: { star_done: boolean };
}

interface Source {
  id: string;
  label: string;
  tab: string;
  safe: number;
  caution: number;
  risky: number;
  items: number;
}

interface Live {
  cpu: number;
  memory_used: number;
  memory_total: number;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function when(days: number | null): string {
  if (days === null) return dt("no forecast yet");
  if (days < 1) return dt("full today");
  if (days < 14) return dt("full in ~{n} d", { n: days });
  if (days < 60) return dt("full in ~{n} wk", { n: Math.round(days / 7) });
  return dt("full in ~{n} mo", { n: Math.round(days / 30) });
}

function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return dt("{n} min ago", { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return dt("{n} h ago", { n: Math.round(s / 3600) });
  return dt("{n} d ago", { n: Math.round(s / 86400) });
}

function Spark({ values, tone }: { values: number[]; tone: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(20 - ((v - min) / span) * 17).toFixed(1)}`);
  return (
    <svg className={`ov-spark t-${tone}`} viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts.join(" ")} />
    </svg>
  );
}

function WeekBars({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <svg className="ov-spark t-safe" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(2, (v / max) * 20) : 1;
        return <rect key={i} x={i * 17 + 1} y={22 - h} width={13} height={h} className={v > 0 ? "" : "is-empty"} />;
      })}
    </svg>
  );
}

function Ring({ value, tone, label }: { value: number; tone: string; label: string }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  return (
    <svg width="80" height="80" viewBox="0 0 80 80" className={`ov-ring t-${tone}`} aria-hidden>
      <circle cx="40" cy="40" r={r} className="ov-ring-track" />
      <circle
        cx="40"
        cy="40"
        r={r}
        className="ov-ring-fill"
        strokeDasharray={c}
        style={{ ["--ring-c" as string]: `${c}`, strokeDashoffset: c * (1 - Math.min(100, value) / 100) }}
        transform="rotate(-90 40 40)"
      />
      <text x="40" y="40" dominantBaseline="central" textAnchor="middle" className="ov-ring-text">
        {label}
      </text>
    </svg>
  );
}

function driveTone(d: DriveCard): string {
  const used = pct(d.used, d.total);
  if (used >= 90 || (d.days_until_full !== null && d.days_until_full < 14)) return "risky";
  if (used >= 75) return "caution";
  return "safe";
}

function SystemMapCard({ map, onNavigate }: { map: Quick["system_map"]; onNavigate: (v: string) => void }) {
  const [lang] = useLang();
  const boxes = useMemo(() => {
    if (!map) return [];
    const items = [...map.folders.map((f) => ({ value: f.bytes, item: f })), { value: map.other, item: { name: dt("Everything else"), path: "", bytes: map.other } }];
    return squarify(items, { x: 0, y: 0, w: 100, h: 100 });
  }, [map, lang]);
  return (
    <div className="ov-card">
      <div className="ov-card-head">
        <span className="ov-k">{dt("Where {root} goes", { root: map?.root ?? dt("the system drive") })}</span>
        {map && <span className="ov-k">{dt("Deep clean, {time}", { time: ago(map.ts) })}</span>}
      </div>
      {map ? (
        <div className="ov-map" onClick={() => onNavigate("deep")} role="button" tabIndex={0} title={dt("Open Deep clean")}>
          {boxes.map((b, i) => (
            <div
              key={b.item.name}
              className={`ov-map-box c${b.item.path ? i % 6 : "x"}`}
              style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}
              title={dt("{p0}: {p1}", { p0: b.item.name, p1: formatBytes(b.value) })}
            >
              {b.w > 14 && b.h > 18 && (
                <span>
                  {b.item.name}
                  <br />
                  <b>{formatBytes(b.value)}</b>
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="ov-empty">
          <span>{dt("Run Deep clean on {root} once and this map fills in.", { root: isWindows ? "C:" : "/" })}</span>
          <button onClick={() => onNavigate("deep")}>{dt("Open Deep clean")}</button>
        </div>
      )}
    </div>
  );
}

export default function Overview({ onNavigate }: { onNavigate: (view: string) => void }) {
  useLang();
  const [quick, setQuick] = useState<Quick | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live[]>([]);

  useEffect(() => {
    invoke<Quick>("overview_quick").then(setQuick).catch((e) => setError(String(e)));
    invoke<Source[]>("overview_cleanable").then(setSources).catch(() => setSources([]));
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      invoke<Live>("gadget_snapshot")
        .then((s) => alive && setLive((l) => [...l.slice(-29), s]))
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const sys = quick?.drives.find((d) => d.system) ?? quick?.drives[0] ?? null;
  const fixed = quick?.drives.filter((d) => !d.removable) ?? [];
  const firstFull = [...fixed].filter((d) => d.days_until_full !== null).sort((a, b) => a.days_until_full! - b.days_until_full!)[0];
  const fullest = firstFull ?? [...fixed].sort((a, b) => pct(b.used, b.total) - pct(a.used, a.total))[0];
  const safeNow = (sources ?? []).filter((s) => ["dev", "models", "appdata"].includes(s.id)).reduce((n, s) => n + s.safe, 0);
  const safeItems = (sources ?? []).filter((s) => ["dev", "models", "appdata"].includes(s.id) && s.safe > 0).length;
  const now = live[live.length - 1];
  const maxSource = Math.max(1, ...(sources ?? []).map((s) => s.safe + s.caution + s.risky));

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title">{dt("Overview")}</h2>
          <p className="view-sub">{dt("Your drives, what Env-Tools has saved, and where space can come from")}</p>
        </div>
      </div>

      {error && <div className="banner-error">{error}</div>}

      <div className="ov-tiles">
        <div className="ov-card ov-rise">
          <span className="ov-k">{dt("Free on {drive}", { drive: sys?.mount ?? dt("system drive") })}</span>
          <span className="ov-big ov-mono">{sys ? formatBytes(sys.free) : dt("…")}</span>
          {sys && sys.trend.length >= 2 ? <Spark values={sys.trend} tone="caution" /> : <span className="ov-k">{sys ? dt("{pct}% used", { pct: pct(sys.used, sys.total) }) : dt("")}</span>}
        </div>
        <div className="ov-card ov-rise">
          <span className="ov-k">{dt("Saved by Env-Tools")}</span>
          <span className="ov-big ov-mono">{quick ? formatBytes(quick.saved_total) : dt("…")}</span>
          {quick && (quick.saved_total > 0 ? <WeekBars values={quick.saved_weeks} /> : <span className="ov-k">{dt("Counts everything Env-Tools moves to the {bin}", { bin: dt(BIN) })}</span>)}
        </div>
        <div className="ov-card ov-rise">
          <span className="ov-k">{dt("Safe to clean now")}</span>
          <span className="ov-big ov-mono t-safe-text">{sources ? formatBytes(safeNow) : dt("…")}</span>
          <span className="ov-k">{sources ? (safeNow > 0 ? dt("in {n} places, comes back by itself", { n: safeItems }) : dt("nothing right now")) : dt("checking your caches…")}</span>
        </div>
        <div className="ov-card ov-rise">
          <span className="ov-k">{dt("Live load")}</span>
          <span className="ov-live ov-mono">
            <span>
              <span className="ov-k">{dt("CPU")}</span>
              {now ? Math.round(now.cpu) : dt("…")}%
            </span>
            <span>
              <span className="ov-k">{dt("RAM")}</span>
              {now ? pct(now.memory_used, now.memory_total) : dt("…")}%
            </span>
          </span>
          <Spark values={live.map((l) => l.cpu)} tone="mem" />
        </div>
      </div>

      <div className="ov-row">
        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-k">{dt("Drives, and when each fills up")}</span>
            {fullest && <span className="ov-k">{dt("Fills first: {drive}", { drive: fullest.mount })}</span>}
          </div>
          <div className="ov-drives">
            {fixed.map((d) => (
              <div key={d.mount} className="ov-drive" title={dt(d.forecast)}>
                <Ring value={pct(d.used, d.total)} tone={driveTone(d)} label={`${pct(d.used, d.total)}%`} />
                <strong>{d.mount}</strong>
                <span className="ov-k">{dt("{size} free", { size: formatBytes(d.free) })}</span>
                <span className="ov-k">{when(d.days_until_full)}</span>
              </div>
            ))}
            {!quick && <span className="ov-k">{dt("Reading your drives…")}</span>}
          </div>
        </div>

        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-k">{dt("Cleanable, by how safe")}</span>
          </div>
          {!sources && (
            <span className="ov-k">
              <span className="spinner sm inline" /> {dt("Checking caches, the {bin} and system files…", { bin: dt(BIN) })}
            </span>
          )}
          {sources && sources.length === 0 && <span className="ov-k">{dt("Nothing found to clean in the usual places.")}</span>}
          <div className="ov-sources">
            {(sources ?? []).map((s) => {
              const total = s.safe + s.caution + s.risky;
              return (
                <button key={s.id} className="ov-source" onClick={() => onNavigate(s.tab)} title={dt("Open {name}", { name: dt(s.label) })}>
                  <span className="ov-source-name">{dt(s.label)}</span>
                  <span className="ov-stack" style={{ width: `${Math.max(6, (total / maxSource) * 100)}%` }}>
                    <i className="s-safe" style={{ flex: s.safe }} />
                    <i className="s-caution" style={{ flex: s.caution }} />
                    <i className="s-risky" style={{ flex: s.risky }} />
                  </span>
                  <span className="ov-mono ov-source-size">{formatBytes(total)}</span>
                </button>
              );
            })}
          </div>
          {sources && sources.length > 0 && (
            <div className="ov-legend">
              <span><i className="s-safe" /> {dt("safe")}</span>
              <span><i className="s-caution" /> {dt("with care")}</span>
              <span><i className="s-risky" /> {dt("review first")}</span>
            </div>
          )}
        </div>
      </div>

      <div className="ov-row">
        <SystemMapCard map={quick?.system_map ?? null} onNavigate={onNavigate} />
        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-k">{dt("Recently cleaned")}</span>
            <button className="btn-ghost sm" onClick={() => onNavigate("bin")}>
              {dt("Restore from the {bin}", { bin: dt(BIN) })}
            </button>
          </div>
          {quick && quick.recent.length === 0 && <span className="ov-k">{dt("Nothing yet. What Env-Tools moves to the {bin} is listed here.", { bin: dt(BIN) })}</span>}
          <ul className="ov-recent">
            {(quick?.recent ?? []).map((b) => (
              <li key={`${b.time}:${b.label}`}>
                <span className="ov-recent-name">
                  {b.items > 1 ? dt("{n} items", { n: b.items }) : dt(b.label)}
                  <span className="ov-k"> · {dt(b.source)} · {ago(b.time)}</span>
                </span>
                <span className="ov-mono">{formatBytes(b.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="ov-actions">
        <button className="ov-primary" onClick={() => onNavigate("dev")}>
          {safeNow > 0 ? dt("Clean {size} safely", { size: formatBytes(safeNow) }) : dt("Open Dev clean")}
        </button>
        <button onClick={() => onNavigate("history")}>{dt("See what grew")}</button>
        <button onClick={() => onNavigate("bin")}>{dt(BIN)}</button>
        <button onClick={() => onNavigate("deep")}>{dt("Deep clean")}</button>
      </div>
    </>
  );
}
