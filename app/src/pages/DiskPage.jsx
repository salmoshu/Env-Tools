// 磁盘管理（第三大导航区，移植自 Jharu github.com/riponcm/Jharu Apache 2.0）。
// 九个标签页：概览、开发缓存、AI 工具、ML 模型、浏览器、Python、垃圾文件、健康预测、目录扫描。
// 支持清理操作（移入回收站）。
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n.js";

function DiskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
const SAFETY_COLORS = { safe: "var(--green)", caution: "var(--yellow)", risky: "var(--red)" };
const SAFETY_LABELS = { safe: "✓ 安全", caution: "⚠ 谨慎", risky: "✕ 风险" };
function SafetyBadge({ level }) {
  return <span style={{ color: SAFETY_COLORS[level] || "var(--faint)", fontSize: 11, fontWeight: 600 }}>{SAFETY_LABELS[level] || level}</span>;
}
function TabBtn({ active, onClick, children }) {
  return <button type="button" className={`tools-tab${active ? " active" : ""}`} onClick={onClick}>{children}</button>;
}
function fmtH(b) {
  if (b >= 1_099_511_627_776) return (b / 1_099_511_627_776).toFixed(1) + " TB";
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + " GB";
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + " MB";
  return Math.round(b / 1024) + " KB";
}
/** 通用全量扫描标签页 */
function FullScanTab({ tab, renderItems }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true); setData(null);
    window.api.diskScanFull(tab).then((r) => setData(r)).catch(() => setData(null)).finally(() => setBusy(false));
  }, [tab]);
  useEffect(() => { load(); }, [load]);
  if (busy) return <div className="status">{t("disk.scanning")}</div>;
  if (!data) return <div className="status">{t("state.noData")}</div>;
  return <>{renderItems(data)}<div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={load}>{t("tip.refresh")}</button></div></>;
}
export default function DiskPage() {
  const [tab, setTab] = useState("overview");
  const [drives, setDrives] = useState(null);
  const [devCaches, setDevCaches] = useState(null);
  const [aiTools, setAiTools] = useState(null);
  const [scanPath, setScanPath] = useState("C:\\");
  const [scanResult, setScanResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [cleanResult, setCleanResult] = useState(null);
  useEffect(() => { window.api.getDiskDrives().then((r) => { if (r?.ok) setDrives(r.drives || []); }).catch(() => {}); }, []);
  useEffect(() => {
    if (tab === "dev" && !devCaches) { setDevCaches("loading");
      window.api.diskDevScan().then((r) => setDevCaches(r?.ok ? r.items || [] : [])).catch(() => setDevCaches([])); }
    if (tab === "ai" && !aiTools) { setAiTools("loading");
      window.api.diskAiTools().then((r) => setAiTools(r?.ok ? r.items || [] : [])).catch(() => setAiTools([])); }
  }, [tab]);
  const runScan = useCallback(async () => {
    if (scanning || !scanPath.trim()) return;
    setScanning(true); setScanResult(null);
    try { const r = await window.api.diskScan(scanPath.trim(), 30, 2); if (r?.ok) setScanResult(r); } catch {}
    setScanning(false);
  }, [scanPath, scanning]);
  const clean = useCallback(async (paths) => {
    if (!paths?.length) return;
    setCleanResult(null);
    try { const r = await window.api.diskClean(paths); setCleanResult(r); } catch {}
  }, []);
  const tabs = [
    ["overview", t("disk.tabOverview")], ["dev", t("disk.tabDev")], ["ai", t("disk.tabAi")],
    ["models", t("disk.tabModels")], ["browsers", t("disk.tabBrowsers")], ["python", t("disk.tabPython")],
    ["junk", t("disk.tabJunk")], ["health", t("disk.tabHealth")], ["scan", t("disk.tabScan")],
  ];
  return (
    <div className="page">
      <header className="page-head"><div><h1>{t("disk.title")}</h1><div className="meta">{t("disk.meta")}</div></div></header>
      {cleanResult && (
        <div className={`error-card${cleanResult.moved > 0 ? "" : " hidden"}`} style={{ marginBottom: 10 }}>
          {t("disk.cleaned").replace("{n}", String(cleanResult.moved || 0))}
          {cleanResult.errors?.length ? ` · ${cleanResult.errors.length} errors` : ""}
        </div>
      )}
      <div className="tools-tabs" role="tablist">{tabs.map(([id, label]) => (
        <TabBtn key={id} active={tab === id} onClick={() => setTab(id)}>{label}</TabBtn>
      ))}</div>

      {tab === "overview" && (<section className="block"><h2>{t("disk.drives")}</h2>
        {!drives ? <div className="status">…</div> : <div className="quota-grid">
          {drives.map((d) => (<div key={d.path} className="qcard" style={{ cursor: "pointer" }} onClick={() => { setScanPath(d.path); setTab("scan"); }} title={t("disk.scanThis")}>
            <div className="qcard-head"><span className="qname mono">{d.path}</span></div>
            <div className="qquota"><div className="qrow"><span>{t("disk.used")}</span><span className="pct">{d.used_percent}%</span></div>
              <div className="bar"><div className={`fill ${d.used_percent > 85 ? "high" : d.used_percent > 60 ? "mid" : "low"}`} style={{ width: `${d.used_percent}%` }} /></div>
              <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>{fmtH(d.used)} / {fmtH(d.total)} · {t("disk.free")} {fmtH(d.available)}</div>
            </div></div>))}
        </div>}</section>)}

      {tab === "dev" && (<section className="block"><h2>{t("disk.tabDev")}</h2>
        <div className="table-hint" style={{ marginBottom: 8 }}>{t("disk.devHint")}</div>
        {devCaches === "loading" ? <div className="status">…</div> : devCaches?.length ? (
          <div className="table-wrap"><table><thead><tr>
            <th className="l">{t("disk.name")}</th><th className="l">{t("disk.safety")}</th><th>{t("disk.size")}</th><th>{t("disk.files")}</th><th className="l">{t("disk.description")}</th><th></th>
          </tr></thead><tbody>
            {devCaches.map((c) => (<tr key={c.id}>
              <td className="l"><b>{c.name}</b></td><td className="l"><SafetyBadge level={c.safety} /></td>
              <td className="mono">{c.size_h}</td><td className="mono">{c.files}</td>
              <td className="l" title={(c.paths || []).join("\n")} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.description}</td>
              <td>{c.safety !== "risky" ? <button className="btn" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => clean(c.paths)}>{t("disk.clean")}</button> : null}</td>
            </tr>))}
          </tbody></table></div>
        ) : <div className="status">{t("state.noData")}</div>}</section>)}

      {tab === "ai" && (<section className="block"><h2>{t("disk.tabAi")}</h2>
        <div className="table-hint" style={{ marginBottom: 8 }}>{t("disk.aiHint")}</div>
        {aiTools === "loading" ? <div className="status">…</div> : aiTools?.length ? (
          <div className="table-wrap"><table><thead><tr>
            <th className="l">{t("disk.tool")}</th><th className="l">{t("disk.kind")}</th><th className="l">{t("disk.safety")}</th><th>{t("disk.size")}</th><th className="l">{t("disk.description")}</th>
          </tr></thead><tbody>
            {aiTools.map((a, i) => (<tr key={i}>
              <td className="l"><b>{a.tool}</b></td><td className="l">{a.kind}</td><td className="l"><SafetyBadge level={a.safety} /></td>
              <td className="mono">{a.size_h}</td><td className="l" title={a.path} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.description}</td>
            </tr>))}
          </tbody></table></div>
        ) : <div className="status">{t("state.noData")}</div>}</section>)}

      {tab === "models" && (<section className="block"><h2>{t("disk.tabModels")}</h2>
        <div className="table-hint" style={{ marginBottom: 8 }}>{t("disk.modelsHint")}</div>
        <FullScanTab tab="models" renderItems={(d) => (
          <><div className="meta" style={{ marginBottom: 8 }}>
            {t("disk.modelsTotal").replace("{n}", String(d.models?.length || 0)).replace("{s}", fmtH(d.total || 0))}
            {d.reliable ? ` · ${t("disk.modelsUnused").replace("{s}", fmtH(d.unused || 0))}` : ""}
          </div>
          <div className="table-wrap"><table><thead><tr>
            <th className="l">Provider</th><th className="l">Model</th><th>{t("disk.size")}</th><th>{t("disk.used")}</th><th>{t("disk.lastUsed")}</th>
          </tr></thead><tbody>
            {(d.models || []).map((m, i) => (<tr key={i}>
              <td className="l">{m.provider}</td><td className="l mono" title={(m.paths || []).join("\n")}>{m.name}</td>
              <td className="mono">{m.size_h}</td>
              <td>{m.used ? "✓" : <span style={{ color: "var(--red)" }}>—</span>}</td>
              <td className="l">{m.last_used_days != null ? `${m.last_used_days}d` : "—"}</td>
            </tr>))}
          </tbody></table></div></>
        )} /></section>)}

      {tab === "browsers" && (<section className="block"><h2>{t("disk.tabBrowsers")}</h2>
        <FullScanTab tab="browsers" renderItems={(d) => (
          <div className="quota-grid">{(d.browsers || []).map((b, i) => (
            <div key={i} className="qcard"><div className="qcard-head"><span className="qname">{b.name}</span></div>
              <div style={{ fontSize: 12, marginTop: 6 }}>{b.total_h}</div>
              <div style={{ marginTop: 8 }}>{(b.items || []).slice(0, 5).map((it, j) => (
                <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--faint)", padding: "2px 0" }}>
                  <span>{it.label}</span><span className="mono">{it.size_h}</span>
                </div>))}
              </div>
            </div>))}
          </div>
        )} /></section>)}

      {tab === "python" && (<section className="block"><h2>{t("disk.tabPython")}</h2>
        <FullScanTab tab="python" renderItems={(d) => (
          <><div className="meta" style={{ marginBottom: 8 }}>{t("disk.pythonTotal").replace("{n}", String(d.envs?.length || 0)).replace("{s}", d.total_h || "0")}</div>
          <div className="table-wrap"><table><thead><tr>
            <th className="l">{t("disk.name")}</th><th className="l">Kind</th><th>{t("disk.size")}</th><th className="l">Top packages</th>
          </tr></thead><tbody>
            {(d.envs || []).map((e, i) => (<tr key={i}>
              <td className="l"><b>{e.name}</b></td><td className="l">{e.kind}</td><td className="mono">{e.size_h}</td>
              <td className="l" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {(e.packages || []).slice(0, 5).map((p) => p.name).join(", ")}
              </td>
            </tr>))}
          </tbody></table></div></>
        )} /></section>)}

      {tab === "junk" && (<section className="block"><h2>{t("disk.tabJunk")}</h2>
        <FullScanTab tab="junk" renderItems={(d) => (
          <div className="table-wrap"><table><thead><tr>
            <th className="l">{t("disk.name")}</th><th>{t("disk.size")}</th><th className="l">{t("disk.description")}</th><th></th>
          </tr></thead><tbody>
            {(d.groups || []).flatMap((g) => (g.items || []).map((it, j) => (
              <tr key={`${g.id}-${j}`}>
                <td className="l"><b>{it.label || g.title}</b></td>
                <td className="mono">{it.size_h || g.total_h}</td>
                <td className="l">{it.safe !== undefined ? <SafetyBadge level={it.safe ? "safe" : "caution"} /> : ""} {g.note}</td>
                <td>{it.safe ? <button className="btn" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => clean([it.path || it.location])}>{t("disk.clean")}</button> : null}</td>
              </tr>
            )))}
          </tbody></table></div>
        )} /></section>)}

      {tab === "health" && (<section className="block"><h2>{t("disk.tabHealth")}</h2>
        <div className="table-hint" style={{ marginBottom: 8 }}>{t("disk.healthHint")}</div>
        <FullScanTab tab="health" renderItems={(d) => (
          <div className="table-wrap"><table><thead><tr>
            <th className="l">Drive</th><th>{t("disk.size")}</th><th>{t("disk.used")}</th><th>Growth</th><th className="l">{t("disk.fullDate")}</th>
          </tr></thead><tbody>
            {(d.forecasts || []).map((f, i) => (<tr key={i}>
              <td className="l mono"><b>{f.path}</b></td>
              <td className="mono">{f.total_gb?.toFixed(0)} GB</td>
              <td className="mono">{f.used_gb?.toFixed(0)} GB</td>
              <td className="mono">{f.growth_gb_per_day?.toFixed(2)} GB/d</td>
              <td className="l">{f.days_to_full != null ? `${f.eta} (${Math.round(f.days_to_full)}d)` : "—"}</td>
            </tr>))}
          </tbody></table></div>
        )} /></section>)}

      {tab === "scan" && (<section className="block"><h2>{t("disk.tabScan")}</h2>
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <input className="key-input mono" style={{ flex: 1, fontFamily: "var(--font-num)" }} placeholder="C:\\Users\\..." value={scanPath} onChange={(e) => setScanPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runScan()} />
          <button type="button" className="btn" disabled={scanning} onClick={runScan}>{scanning ? t("disk.scanning") : t("disk.scanBtn")}</button>
        </div>
        {scanResult && (<><div className="meta" style={{ marginBottom: 8 }}>{scanResult.path} · {scanResult.total_h} · {scanResult.elapsed_ms}ms</div>
          <div className="table-wrap"><table><thead><tr><th className="l">{t("disk.name")}</th><th className="l">{t("disk.type")}</th><th>{t("disk.size")}</th></tr></thead><tbody>
            {(scanResult.items || []).map((item, i) => (<tr key={i}>
              <td className="l mono" title={item.name}>{item.name}</td><td className="l">{item.is_dir ? "📁" : "📄"}</td><td className="mono"><b>{item.size_h}</b></td>
            </tr>))}</tbody></table></div></>)}</section>)}
    </div>
  );
}
export { DiskIcon };
