import { useEffect, useMemo, useState } from "react";
import { invoke } from "../adapter";
import { formatBytes, isWindows } from "../format";
import { squarify } from "../components/squarify";

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
  if (days === null) return "no forecast yet";
  if (days < 1) return "full today";
  if (days < 14) return `full in ~${days} d`;
  if (days < 60) return `full in ~${Math.round(days / 7)} wk`;
  return `full in ~${Math.round(days / 30)} mo`;
}

function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
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
  const boxes = useMemo(() => {
    if (!map) return [];
    const items = [...map.folders.map((f) => ({ value: f.bytes, item: f })), { value: map.other, item: { name: "Everything else", path: "", bytes: map.other } }];
    return squarify(items, { x: 0, y: 0, w: 100, h: 100 });
  }, [map]);
  return (
    <div className="ov-card">
      <div className="ov-card-head">
        <span className="ov-k">Where {map?.root ?? "the system drive"} goes</span>
        {map && <span className="ov-k">Deep clean, {ago(map.ts)}</span>}
      </div>
      {map ? (
        <div className="ov-map" onClick={() => onNavigate("deep")} role="button" tabIndex={0} title="Open Deep clean">
          {boxes.map((b, i) => (
            <div
              key={b.item.name}
              className={`ov-map-box c${b.item.path ? i % 6 : "x"}`}
              style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}
              title={`${b.item.name}: ${formatBytes(b.value)}`}
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
          <span>Run Deep clean on {isWindows ? "C:" : "/"} once and this map fills in.</span>
          <button onClick={() => onNavigate("deep")}>Open Deep clean</button>
        </div>
      )}
    </div>
  );
}

export default function Overview({ onNavigate }: { onNavigate: (view: string) => void }) {
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
          <h2 className="view-title">Overview</h2>
          <p className="view-sub">Your drives, what Env-Tools has saved, and where space can come from</p>
        </div>
      </div>

      {error && <div className="banner-error">{error}</div>}

      <div className="ov-tiles">
        <div className="ov-card ov-rise">
          <span className="ov-k">Free on {sys?.mount ?? "system drive"}</span>
          <span className="ov-big ov-mono">{sys ? formatBytes(sys.free) : "…"}</span>
          {sys && sys.trend.length >= 2 ? <Spark values={sys.trend} tone="caution" /> : <span className="ov-k">{sys ? `${pct(sys.used, sys.total)}% used` : ""}</span>}
        </div>
        <div className="ov-card ov-rise">
          <span className="ov-k">Saved by Env-Tools</span>
          <span className="ov-big ov-mono">{quick ? formatBytes(quick.saved_total) : "…"}</span>
          {quick && (quick.saved_total > 0 ? <WeekBars values={quick.saved_weeks} /> : <span className="ov-k">Counts everything Env-Tools moves to the {BIN}</span>)}
        </div>
        <div className="ov-card ov-rise">
          <span className="ov-k">Safe to clean now</span>
          <span className="ov-big ov-mono t-safe-text">{sources ? formatBytes(safeNow) : "…"}</span>
          <span className="ov-k">{sources ? (safeNow > 0 ? `in ${safeItems} ${safeItems === 1 ? "place" : "places"}, comes back by itself` : "nothing right now") : "checking your caches…"}</span>
        </div>
        <div className="ov-card ov-rise">
          <span className="ov-k">Live load</span>
          <span className="ov-live ov-mono">
            <span>
              <span className="ov-k">CPU </span>
              {now ? Math.round(now.cpu) : "…"}%
            </span>
            <span>
              <span className="ov-k">RAM </span>
              {now ? pct(now.memory_used, now.memory_total) : "…"}%
            </span>
          </span>
          <Spark values={live.map((l) => l.cpu)} tone="mem" />
        </div>
      </div>

      <div className="ov-row">
        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-k">Drives, and when each fills up</span>
            {fullest && <span className="ov-k">Fills first: {fullest.mount}</span>}
          </div>
          <div className="ov-drives">
            {fixed.map((d) => (
              <div key={d.mount} className="ov-drive" title={d.forecast}>
                <Ring value={pct(d.used, d.total)} tone={driveTone(d)} label={`${pct(d.used, d.total)}%`} />
                <strong>{d.mount}</strong>
                <span className="ov-k">{formatBytes(d.free)} free</span>
                <span className="ov-k">{when(d.days_until_full)}</span>
              </div>
            ))}
            {!quick && <span className="ov-k">Reading your drives…</span>}
          </div>
        </div>

        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-k">Cleanable, by how safe</span>
          </div>
          {!sources && (
            <span className="ov-k">
              <span className="spinner sm inline" /> Checking caches, the {BIN} and system files…
            </span>
          )}
          {sources && sources.length === 0 && <span className="ov-k">Nothing found to clean in the usual places.</span>}
          <div className="ov-sources">
            {(sources ?? []).map((s) => {
              const total = s.safe + s.caution + s.risky;
              return (
                <button key={s.id} className="ov-source" onClick={() => onNavigate(s.tab)} title={`Open ${s.label}`}>
                  <span className="ov-source-name">{s.label}</span>
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
              <span><i className="s-safe" /> safe</span>
              <span><i className="s-caution" /> with care</span>
              <span><i className="s-risky" /> review first</span>
            </div>
          )}
        </div>
      </div>

      <div className="ov-row">
        <SystemMapCard map={quick?.system_map ?? null} onNavigate={onNavigate} />
        <div className="ov-card">
          <div className="ov-card-head">
            <span className="ov-k">Recently cleaned</span>
            <button className="btn-ghost sm" onClick={() => onNavigate("bin")}>
              Restore from the {BIN}
            </button>
          </div>
          {quick && quick.recent.length === 0 && <span className="ov-k">Nothing yet. What Env-Tools moves to the {BIN} is listed here.</span>}
          <ul className="ov-recent">
            {(quick?.recent ?? []).map((b) => (
              <li key={`${b.time}:${b.label}`}>
                <span className="ov-recent-name">
                  {b.label}
                  <span className="ov-k"> · {b.source} · {ago(b.time)}</span>
                </span>
                <span className="ov-mono">{formatBytes(b.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="ov-actions">
        <button className="ov-primary" onClick={() => onNavigate("dev")}>
          {safeNow > 0 ? `Clean ${formatBytes(safeNow)} safely` : "Open Dev clean"}
        </button>
        <button onClick={() => onNavigate("history")}>See what grew</button>
        <button onClick={() => onNavigate("bin")}>{BIN}</button>
        <button onClick={() => onNavigate("deep")}>Deep clean</button>
      </div>
    </>
  );
}
