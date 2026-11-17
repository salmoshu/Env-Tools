// 磁盘管理（第三大导航区，移植自 Jharu github.com/riponcm/Jharu Apache 2.0）。
// Jharu 风格左侧栏（分组+图标+副标题）+ 右侧内容区。
// 概览用环形图驱动器卡片（Ring 组件），各子页带安全分级与清理按钮。
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n.js";

function DiskIcon() {
  return (<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></svg>);
}
const SAFETY = { safe: "var(--green)", caution: "var(--yellow)", risky: "var(--red)" };
const SAFETY_L = { safe: "✓", caution: "⚠", risky: "✕" };
function Safe({ level }) { return <span style={{ color: SAFETY[level] || "var(--faint)", fontSize: 11 }}>{SAFETY_L[level] || "·"}</span>; }
function fmtH(b) {
  if (b >= 1e12) return (b / 1e12).toFixed(1) + " TB";
  if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  return Math.round(b / 1e3) + " KB";
}
function when(days) {
  if (days == null) return t("disk.noForecast");
  if (days < 1) return t("disk.fullToday");
  if (days < 14) return t("disk.fullDays").replace("{n}", Math.round(days));
  if (days < 60) return t("disk.fullWeeks").replace("{n}", Math.round(days / 7));
  return t("disk.fullMonths").replace("{n}", Math.round(days / 30));
}
/** 环形图（Jharu Ring 组件复刻） */
function Ring({ value, tone, label }) {
  const r = 30, c = 2 * Math.PI * r;
  const colors = { ok: "var(--green)", warn: "var(--yellow)", bad: "var(--red)" };
  return (
    <svg width="72" height="72" viewBox="0 0 72 72">
      <circle cx="36" cy="36" r={r} fill="none" stroke="var(--track)" strokeWidth="6" />
      <circle cx="36" cy="36" r={r} fill="none" stroke={colors[tone] || "var(--green)"} strokeWidth="6"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, value) / 100)}
        transform="rotate(-90 36 36)" strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s ease" }} />
      <text x="36" y="36" dominantBaseline="central" textAnchor="middle"
        fill="var(--text)" fontSize="14" fontWeight="700">{label}</text>
    </svg>
  );
}
function driveTone(usedPct, daysToFull) {
  if (usedPct >= 90 || (daysToFull != null && daysToFull < 14)) return "bad";
  if (usedPct >= 75) return "warn";
  return "ok";
}
/** 子导航定义（Jharu NAV 结构复刻） */
const NAV = [
  { group: "", items: [{ id: "overview", label: "Overview", icon: "◎", sub: "Drives & forecast" }] },
  { group: "Developer", items: [
    { id: "dev", label: "Dev clean", icon: "⌘", sub: "Dev caches" },
    { id: "models", label: "ML models", icon: "◈", sub: "Used or not" },
    { id: "python", label: "Python", icon: "◐", sub: "Envs" },
    { id: "ai", label: "AI tools", icon: "✦", sub: "Agent artifacts" },
  ]},
  { group: "Disk", items: [
    { id: "browsers", label: "Browsers", icon: "◍", sub: "Web caches" },
    { id: "junk", label: "Junk files", icon: "▤", sub: "Installers, temp" },
    { id: "scan", label: "Dir scan", icon: "◉", sub: "Size ranking" },
  ]},
  { group: "Insight", items: [
    { id: "health", label: "Health", icon: "♥", sub: "SMART & forecast" },
  ]},
];

export default function DiskPage() {
  const [view, setView] = useState("overview");
  const [drives, setDrives] = useState(null);
  const [devCaches, setDevCaches] = useState(null);
  const [aiTools, setAiTools] = useState(null);
  const [fullData, setFullData] = useState({});
  const [scanPath, setScanPath] = useState("C:\\");
  const [scanResult, setScanResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [cleanResult, setCleanResult] = useState(null);

  useEffect(() => { window.api.getDiskDrives().then((r) => { if (r?.ok) setDrives(r.drives || []); }).catch(() => {}); }, []);
  useEffect(() => {
    if (view === "dev" && devCaches === null) { setDevCaches("loading");
      window.api.diskDevScan().then((r) => setDevCaches(r?.ok ? r.items || [] : [])).catch(() => setDevCaches([])); }
    if (view === "ai" && aiTools === null) { setAiTools("loading");
      window.api.diskAiTools().then((r) => setAiTools(r?.ok ? r.items || [] : [])).catch(() => setAiTools([])); }
    const fullTabs = ["models", "browsers", "python", "junk", "health"];
    if (fullTabs.includes(view) && !fullData[view]) {
      window.api.diskScanFull(view).then((r) => setFullData((p) => ({ ...p, [view]: r }))).catch(() => setFullData((p) => ({ ...p, [view]: null })));
    }
  }, [view]);

  const runScan = useCallback(async () => {
    if (scanning || !scanPath.trim()) return;
    setScanning(true); setScanResult(null);
    try { const r = await window.api.diskScan(scanPath.trim(), 30, 2); if (r?.ok) setScanResult(r); } catch {}
    setScanning(false);
  }, [scanPath, scanning]);
  const clean = useCallback(async (paths) => {
    if (!paths?.length) return; setCleanResult(null);
    try { const r = await window.api.diskClean(paths); setCleanResult(r); } catch {}
  }, []);

  const currentTitle = NAV.flatMap((g) => g.items).find((n) => n.id === view)?.label || "";

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* Jharu 风格左侧栏 */}
      <aside className="disk-sidebar">
        {NAV.map((g) => (
          <div key={g.group} className="disk-nav-group">
            {g.group && <span className="disk-nav-title">{g.group}</span>}
            {g.items.map((n) => (
              <button key={n.id} className={`disk-nav-item${view === n.id ? " active" : ""}`} onClick={() => setView(n.id)}>
                <span className="disk-nav-icon">{n.icon}</span>
                <span className="disk-nav-text">
                  <span className="disk-nav-label">{n.label}</span>
                  <span className="disk-nav-sub">{n.sub}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
        <div style={{ marginTop: "auto", fontSize: 10, color: "var(--faint)", padding: "0 10px" }}>
          {t("disk.sidebarFoot")}
        </div>
      </aside>

      {/* 右侧内容区 */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "20px 24px" }}>
        {cleanResult && <div style={{ marginBottom: 10, fontSize: 12, color: "var(--green)" }}>{t("disk.cleaned").replace("{n}", cleanResult.moved || 0)}</div>}

        {view === "overview" && drives && (
          <div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 20 }}>
              {drives.map((d) => {
                const pct = Math.round(d.used_percent || 0);
                const tone = driveTone(pct);
                return (
                  <div key={d.path} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 100, cursor: "pointer" }}
                    onClick={() => { setScanPath(d.path); setView("scan"); }}>
                    <Ring value={pct} tone={tone} label={`${pct}%`} />
                    <strong style={{ fontSize: 13 }}>{d.path}</strong>
                    <span style={{ fontSize: 11, color: "var(--dim)" }}>{fmtH(d.available)} {t("disk.free")}</span>
                    <span style={{ fontSize: 10, color: "var(--faint)" }}>{fmtH(d.used)} / {fmtH(d.total)}</span>
                  </div>
                );
              })}
            </div>
            {/* 健康预测摘要 */}
            {fullData.health?.forecasts?.length > 0 && (
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: "var(--faint)", marginBottom: 6 }}>{t("disk.tabHealth")}</div>
                {fullData.health.forecasts.map((f, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                    <span className="mono">{f.path}</span>
                    <span style={{ color: "var(--dim)" }}>
                      {f.growth_gb_per_day?.toFixed(2)} GB/d · {when(f.days_to_full)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {view === "overview" && !drives && <div className="status">…</div>}

        {view === "dev" && devCaches === "loading" && <div className="status">…</div>}
        {view === "dev" && Array.isArray(devCaches) && (
          <div className="table-wrap"><table>
            <thead><tr><th className="l">{t("disk.name")}</th><th className="l">{t("disk.safety")}</th><th>{t("disk.size")}</th><th className="l">{t("disk.description")}</th></tr></thead>
            <tbody>{devCaches.map((c) => (<tr key={c.id}>
              <td className="l"><b>{c.name}</b></td><td className="l"><Safe level={c.safety} /></td>
              <td className="mono">{c.size_h}</td>
              <td className="l" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>{c.description}</td>
            </tr>))}</tbody>
          </table></div>
        )}

        {view === "ai" && aiTools === "loading" && <div className="status">…</div>}
        {view === "ai" && Array.isArray(aiTools) && (
          <div className="table-wrap"><table>
            <thead><tr><th className="l">{t("disk.tool")}</th><th className="l">{t("disk.safety")}</th><th>{t("disk.size")}</th><th className="l">{t("disk.description")}</th></tr></thead>
            <tbody>{aiTools.map((a, i) => (<tr key={i}>
              <td className="l"><b>{a.tool}</b> <span style={{ color: "var(--faint)", fontSize: 10 }}>{a.kind}</span></td>
              <td className="l"><Safe level={a.safety} /></td><td className="mono">{a.size_h}</td>
              <td className="l" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }} title={a.path}>{a.description}</td>
            </tr>))}</tbody>
          </table></div>
        )}

        {view === "models" && fullData.models && (
          <div className="table-wrap"><table>
            <thead><tr><th className="l">Provider</th><th className="l">Model</th><th>{t("disk.size")}</th><th>Used</th><th>Last</th></tr></thead>
            <tbody>{(fullData.models.models || []).map((m, i) => (<tr key={i}>
              <td className="l">{m.provider}</td><td className="l mono" title={(m.paths||[]).join("\n")}>{m.name}</td>
              <td className="mono">{m.size_h}</td>
              <td>{m.used ? "✓" : <span style={{ color: "var(--red)" }}>—</span>}</td>
              <td>{m.last_used_days != null ? `${m.last_used_days}d` : "—"}</td>
            </tr>))}</tbody>
          </table></div>
        )}

        {view === "browsers" && fullData.browsers && (
          <div className="quota-grid">{(fullData.browsers.browsers || []).map((b, i) => (
            <div key={i} className="qcard"><div className="qcard-head"><span className="qname">{b.name}</span></div>
              <div style={{ fontSize: 12, marginTop: 6, color: "var(--dim)" }}>{b.total_h}</div>
              <div style={{ marginTop: 8 }}>{(b.items||[]).slice(0,5).map((it, j) => (
                <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--faint)", padding: "2px 0" }}>
                  <span>{it.label}</span><span className="mono">{it.size_h}</span>
                </div>))}
              </div>
            </div>))}
          </div>
        )}

        {view === "python" && fullData.python && (
          <div className="table-wrap"><table>
            <thead><tr><th className="l">{t("disk.name")}</th><th>Kind</th><th>{t("disk.size")}</th></tr></thead>
            <tbody>{(fullData.python.envs || []).map((e, i) => (<tr key={i}>
              <td className="l"><b>{e.name}</b></td><td>{e.kind}</td><td className="mono">{e.size_h}</td>
            </tr>))}</tbody>
          </table></div>
        )}

        {view === "junk" && fullData.junk && (
          <div className="table-wrap"><table>
            <thead><tr><th className="l">{t("disk.name")}</th><th>{t("disk.size")}</th><th className="l">{t("disk.description")}</th></tr></thead>
            <tbody>{(fullData.junk.groups || []).flatMap((g) => (g.items||[]).map((it, j) => (
              <tr key={`${g.id}-${j}`}><td className="l"><b>{it.label || g.title}</b></td>
              <td className="mono">{it.size_h || g.total_h}</td><td className="l">{g.note}</td></tr>
            )))}</tbody>
          </table></div>
        )}

        {view === "health" && fullData.health && (
          <div className="table-wrap"><table>
            <thead><tr><th className="l">Drive</th><th>Total</th><th>Used</th><th>Growth</th><th className="l">{t("disk.fullDate")}</th></tr></thead>
            <tbody>{(fullData.health.forecasts || []).map((f, i) => (<tr key={i}>
              <td className="l mono"><b>{f.path}</b></td>
              <td className="mono">{f.total_gb?.toFixed(0)} GB</td><td className="mono">{f.used_gb?.toFixed(0)} GB</td>
              <td className="mono">{f.growth_gb_per_day?.toFixed(2)} GB/d</td>
              <td className="l">{f.days_to_full != null ? `${f.eta} (~${Math.round(f.days_to_full)}d)` : "—"}</td>
            </tr>))}</tbody>
          </table></div>
        )}

        {view === "scan" && (
          <div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <input className="key-input mono" style={{ flex: 1, fontFamily: "var(--font-num)" }} placeholder="C:\\Users\\..." value={scanPath} onChange={(e) => setScanPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runScan()} />
              <button type="button" className="btn refresh-inline" disabled={scanning} onClick={runScan}>{scanning ? t("disk.scanning") : t("disk.scanBtn")}</button>
            </div>
            {scanResult && (<>
              <div className="meta" style={{ marginBottom: 8 }}>{scanResult.path} · {scanResult.total_h} · {scanResult.elapsed_ms}ms</div>
              <div className="table-wrap"><table>
                <thead><tr><th className="l">{t("disk.name")}</th><th className="l">{t("disk.type")}</th><th>{t("disk.size")}</th></tr></thead>
                <tbody>{(scanResult.items || []).map((item, i) => (<tr key={i}>
                  <td className="l mono" title={item.name}>{item.name}</td>
                  <td className="l">{item.is_dir ? "📁" : "📄"}</td><td className="mono"><b>{item.size_h}</b></td>
                </tr>))}</tbody>
              </table></div></>)}
          </div>
        )}
      </div>
    </div>
  );
}
export { DiskIcon };
