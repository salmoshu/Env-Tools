import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "../adapter";
import { getCurrentWindow } from "../adapter";
import { formatBytes, isMac, isWindows } from "../format";
import { dt, useLang } from "../i18n";

type Mode = "bar" | "card";

interface Settings {
  enabled: boolean;
  mode: Mode;
}

interface Program {
  name: string;
  cpu: number;
  memory: number;
  processes: number;
}

interface Drive {
  mount: string;
  free: number;
  total: number;
  days_until_full: number | null;
  forecast: string;
}

interface Snapshot {
  cpu: number;
  memory_used: number;
  memory_total: number;
  drive: Drive | null;
  top: Program[];
  processes: number;
}

interface CleanedItem {
  name: string;
  path: string;
  bytes: number;
}

interface CleanRun {
  freed_bytes: number;
  removed: CleanedItem[];
  skipped: string[];
  errors: string[];
}

type CleanState =
  | { phase: "idle" }
  | { phase: "looking" }
  | { phase: "confirm"; run: CleanRun }
  | { phase: "cleaning" }
  | { phase: "done"; run: CleanRun }
  | { phase: "error"; message: string };

const BIN = isWindows ? "Recycle Bin" : "Trash";
const REFRESH_MS = 2000;

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);

function untilFull(days: number | null): string | null {
  if (days === null) return null;
  if (days < 1) return dt("full today");
  if (days < 14) return dt("full in {n} d", { n: days });
  if (days < 60) return dt("full in {n} wk", { n: Math.round(days / 7) });
  return dt("full in {n} mo", { n: Math.round(days / 30) });
}

/// Free space shown in a ring's centre: "84G", "512M".
function shortFree(bytes: number): string {
  const unit = isWindows ? 1024 : 1000;
  const g = bytes / unit ** 3;
  return g >= 10 ? `${Math.round(g)}G` : g >= 1 ? `${g.toFixed(1)}G` : `${Math.round(bytes / unit ** 2)}M`;
}

/// A ring gauge. `tone` picks the accent; past 90 % every ring turns red.
function Ring({ value, size, stroke, tone, label }: { value: number; size: number; stroke: number; tone: "cpu" | "mem" | "disk"; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={`g-ring t-${tone} ${v >= 90 ? "is-high" : ""}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} className="g-ring-track" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="g-ring-fill"
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {label && (
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="g-ring-text">
          {label}
        </text>
      )}
    </svg>
  );
}

/// Line icons drawn here: font glyphs for arrows and crosses render as dots
/// at this size on some systems.
const ICONS = {
  down: "M4 6l4 4 4-4",
  up: "M4 10l4-4 4 4",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  open: "M9 3h4v4M13 3L7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5",
};

function IconButton({ name, label, onClick }: { name: keyof typeof ICONS; label: string; onClick: () => void }) {
  return (
    <button className={`g-icon ${name === "close" ? "is-close" : ""}`} onClick={onClick} title={label} aria-label={label}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/// Drags the window from anywhere that is not a button.
function dragFrom(e: React.MouseEvent) {
  if (e.button === 0 && !(e.target as HTMLElement).closest("button")) {
    getCurrentWindow().startDragging().catch(() => {});
  }
}

export default function Gadget() {
  useLang();
  const [mode, setMode] = useState<Mode>("bar");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [clean, setClean] = useState<CleanState>({ phase: "idle" });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<Settings>("gadget_get").then((s) => setMode(s.mode)).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      invoke<Snapshot>("gadget_snapshot")
        .then((s) => alive && setSnap(s))
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // The window takes exactly the size of what it shows, so the rounded
  // corners sit on its edges and nothing is cut off as text changes.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = "";
    const fit = () => {
      // macOS: the window is not transparent, so the shell is widened to the
      // whole pixel the window rounds up to; otherwise a dark sliver shows
      // beside its right edge.
      if (isMac) el.style.width = "";
      const r = el.getBoundingClientRect();
      if (isMac) el.style.width = `${Math.ceil(r.width)}px`;
      const key = `${Math.ceil(r.width)}x${Math.ceil(r.height)}`;
      if (key !== last) {
        last = key;
        invoke("gadget_fit", { width: r.width, height: r.height }).catch(() => {});
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    // With a fixed width the box no longer resizes when its text changes,
    // so on macOS changes inside it are watched as well.
    const mo = new MutationObserver(fit);
    if (isMac) mo.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [mode]);

  const switchTo = (m: Mode) => {
    setMode(m);
    invoke("gadget_set", { enabled: true, mode: m }).catch(() => {});
  };
  const turnOff = () => invoke("gadget_set", { enabled: false, mode }).catch(() => {});
  const openMain = () => invoke("gadget_open_main").catch(() => {});

  // The one action: the same preview-then-confirm as Space history's
  // "clean safe caches", so it obeys the same rules and checks.
  const findSafe = useCallback(() => {
    setClean({ phase: "looking" });
    invoke<CleanRun>("autocare_preview", { settings: null })
      .then((run) => setClean({ phase: "confirm", run }))
      .catch((e) => setClean({ phase: "error", message: String(e) }));
  }, []);

  const runClean = (run: CleanRun) => {
    setClean({ phase: "cleaning" });
    invoke<CleanRun>("autocare_run_now", { paths: run.removed.map((r) => r.path), settings: null })
      .then((done) => setClean({ phase: "done", run: done }))
      .catch((e) => setClean({ phase: "error", message: String(e) }));
  };

  const cpu = Math.round(snap?.cpu ?? 0);
  const mem = pct(snap?.memory_used ?? 0, snap?.memory_total ?? 0);
  const d = snap?.drive ?? null;
  const diskUsed = d ? pct(d.total - d.free, d.total) : 0;
  const full = d ? untilFull(d.days_until_full) : null;

  if (mode === "bar") {
    return (
      <div ref={box} className="g-shell g-bar" onMouseDown={dragFrom}>
        <span className="g-stat">
          <Ring value={cpu} size={24} stroke={3} tone="cpu" />
          <span className="g-k">{dt("CPU")}</span>
          <span className="g-v">{cpu}%</span>
        </span>
        <span className="g-stat">
          <Ring value={mem} size={24} stroke={3} tone="mem" />
          <span className="g-k">{dt("RAM")}</span>
          <span className="g-v">{mem}%</span>
        </span>
        {d && (
          <>
            <span className="g-divider" />
            <span className="g-stat" title={dt(d.forecast)}>
              <span className="g-k">{d.mount}</span>
              <span className={`g-v ${diskUsed >= 90 ? "is-high" : ""}`}>{formatBytes(d.free)}</span>
              <span className="g-k">{full ?? dt("free")}</span>
            </span>
          </>
        )}
        <span className="g-actions">
          <IconButton name="open" label={dt("Open Env-Tools")} onClick={openMain} />
          <IconButton name="down" label={dt("Show more")} onClick={() => switchTo("card")} />
          <IconButton name="close" label={dt("Turn the gadget off")} onClick={turnOff} />
        </span>
      </div>
    );
  }

  return (
    <div ref={box} className="g-shell g-card">
      <div className="g-head" onMouseDown={dragFrom}>
        <span className="g-title">{dt("Env-Tools")}</span>
        <span className="g-k">{snap ? dt("{p0} processes", { p0: snap.processes }) : dt("reading…")}</span>
        <span className="g-actions">
          <IconButton name="open" label={dt("Open Env-Tools")} onClick={openMain} />
          <IconButton name="up" label={dt("Make it a bar")} onClick={() => switchTo("bar")} />
          <IconButton name="close" label={dt("Turn the gadget off")} onClick={turnOff} />
        </span>
      </div>

      <div className="g-rings" onMouseDown={dragFrom}>
        <div className="g-gauge">
          <Ring value={cpu} size={60} stroke={5} tone="cpu" label={`${cpu}%`} />
          <span className="g-k">{dt("CPU")}</span>
        </div>
        <div className="g-gauge" title={dt("{p0} of {p1}", { p0: formatBytes(snap?.memory_used ?? 0), p1: formatBytes(snap?.memory_total ?? 0) })}>
          <Ring value={mem} size={60} stroke={5} tone="mem" label={`${mem}%`} />
          <span className="g-k">{dt("Memory")}</span>
        </div>
        {d && (
          <div className="g-gauge" title={dt("{p0} free of {p1}", { p0: formatBytes(d.free), p1: formatBytes(d.total) })}>
            <Ring value={diskUsed} size={60} stroke={5} tone="disk" label={shortFree(d.free)} />
            <span className="g-k">{dt("{mount} free", { mount: d.mount })}</span>
          </div>
        )}
      </div>
      {d && <p className="g-note">{dt(d.forecast)}</p>}

      <div className="g-section">{dt("Busiest now")}</div>
      <ul className="g-top">
        {(snap?.top ?? []).map((p) => (
          <li key={p.name}>
            <span className="g-name" title={p.processes > 1 ? dt("{p0} processes", { p0: p.processes }) : undefined}>
              {p.name}
            </span>
            <span className="g-v">{p.cpu.toFixed(0)}%</span>
            <span className="g-k g-mem">{formatBytes(p.memory)}</span>
          </li>
        ))}
        {snap && snap.top.length === 0 && <li className="g-k">{dt("Nothing busy right now.")}</li>}
      </ul>

      <div className="g-clean">
        {clean.phase === "idle" && (
          <button className="g-btn is-accent" onClick={findSafe}>{dt("Clean safe caches")}</button>
        )}
        {clean.phase === "looking" && <span className="g-k">{dt("Looking for caches that are safe to clear…")}</span>}
        {clean.phase === "confirm" &&
          (clean.run.removed.length === 0 ? (
            <span className="g-k">
              {dt("Nothing is safe to clear right now")}
              {clean.run.skipped.length > 0 && dt(" ({n} caches checked; Space history says why)", { n: clean.run.skipped.length })}.{dt(" ")}
              <button className="g-link" onClick={() => setClean({ phase: "idle" })}>{dt("OK")}</button>
            </span>
          ) : (
            <span className="g-confirm">
              <span>{dt(clean.run.removed.length === 1 ? "{n} cache, {size} to the {bin}." : "{n} caches, {size} to the {bin}.", {
                n: clean.run.removed.length, size: formatBytes(clean.run.freed_bytes), bin: dt(BIN),
              })}</span>
              <button className="g-btn is-accent" onClick={() => runClean(clean.run)}>{dt("Clean")}</button>
              <button className="g-link" onClick={() => setClean({ phase: "idle" })}>{dt("Cancel")}</button>
            </span>
          ))}
        {clean.phase === "cleaning" && <span className="g-k">{dt("Moving caches to the {bin}…", { bin: dt(BIN) })}</span>}
        {clean.phase === "done" && (
          <span className="g-k">
            {dt("Freed {size}", { size: formatBytes(clean.run.freed_bytes) })}
            {clean.run.skipped.length > 0 && dt(", {n} left in place", { n: clean.run.skipped.length })}.{dt(" ")}
            <button className="g-link" onClick={() => setClean({ phase: "idle" })}>{dt("OK")}</button>
          </span>
        )}
        {clean.phase === "error" && (
          <span className="g-k g-err">
            {clean.message}{dt(" ")}
            <button className="g-link" onClick={() => setClean({ phase: "idle" })}>{dt("OK")}</button>
          </span>
        )}
      </div>

      <button className="g-btn" onClick={openMain}>{dt("Open Env-Tools")}</button>
    </div>
  );
}
