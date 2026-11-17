// 磁盘管理（第三大导航区，移植自 Jharu github.com/riponcm/Jharu Apache 2.0）。
// 四个标签页：概览（驱动器+水位）、开发缓存（25+ 规则安全分级）、
// AI 工具痕迹（各 agent 遗留数据）、目录扫描（体积排行）。
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n.js";

function DiskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

const SAFETY_COLORS = { safe: "var(--green)", caution: "var(--yellow)", risky: "var(--red)" };
const SAFETY_LABELS = { safe: "✓ 安全", caution: "⚠ 谨慎", risky: "✕ 风险" };

function SafetyBadge({ level }) {
  return (
    <span className="safety-badge" style={{ color: SAFETY_COLORS[level] || "var(--faint)" }}>
      {SAFETY_LABELS[level] || level}
    </span>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button type="button" className={`tools-tab${active ? " active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export default function DiskPage() {
  const [tab, setTab] = useState("overview");
  const [drives, setDrives] = useState(null);
  const [devCaches, setDevCaches] = useState(null);
  const [aiTools, setAiTools] = useState(null);
  const [scanPath, setScanPath] = useState("C:\\");
  const [scanResult, setScanResult] = useState(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    window.api.getDiskDrives().then((r) => { if (r?.ok) setDrives(r.drives || []); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "dev" && !devCaches) {
      setDevCaches("loading");
      window.api.diskDevScan().then((r) => { if (r?.ok) setDevCaches(r.items || []); else setDevCaches([]); }).catch(() => setDevCaches([]));
    }
    if (tab === "ai" && !aiTools) {
      setAiTools("loading");
      window.api.diskAiTools().then((r) => { if (r?.ok) setAiTools(r.items || []); else setAiTools([]); }).catch(() => setAiTools([]));
    }
  }, [tab]);

  const runScan = useCallback(async () => {
    if (scanning || !scanPath.trim()) return;
    setScanning(true); setScanResult(null);
    try {
      const r = await window.api.diskScan(scanPath.trim(), 30, 2);
      if (r?.ok) setScanResult(r);
    } catch {}
    setScanning(false);
  }, [scanPath, scanning]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("disk.title")}</h1>
          <div className="meta">{t("disk.meta")}</div>
        </div>
      </header>

      <div className="tools-tabs" role="tablist">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>{t("disk.tabOverview")}</TabButton>
        <TabButton active={tab === "dev"} onClick={() => setTab("dev")}>{t("disk.tabDev")}</TabButton>
        <TabButton active={tab === "ai"} onClick={() => setTab("ai")}>{t("disk.tabAi")}</TabButton>
        <TabButton active={tab === "scan"} onClick={() => setTab("scan")}>{t("disk.tabScan")}</TabButton>
      </div>

      {tab === "overview" && (
        <section className="block">
          <h2>{t("disk.drives")}</h2>
          {!drives ? <div className="status">…</div> : (
            <div className="quota-grid">
              {drives.map((d) => (
                <div key={d.path} className="qcard" style={{ cursor: "pointer" }} onClick={() => { setScanPath(d.path); setTab("scan"); }} title={t("disk.scanThis")}>
                  <div className="qcard-head"><span className="qname mono">{d.path}</span></div>
                  <div className="qquota">
                    <div className="qrow"><span>{t("disk.used")}</span><span className="pct">{d.used_percent}%</span></div>
                    <div className="bar"><div className={`fill ${d.used_percent > 85 ? "high" : d.used_percent > 60 ? "mid" : "low"}`} style={{ width: `${d.used_percent}%` }} /></div>
                    <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>
                      {fmtH(d.used)} / {fmtH(d.total)} · {t("disk.free")} {fmtH(d.available)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "dev" && (
        <section className="block">
          <h2>{t("disk.tabDev")}</h2>
          <div className="table-hint" style={{ marginBottom: 8 }}>{t("disk.devHint")}</div>
          {devCaches === "loading" ? <div className="status">{t("disk.scanning")}</div> :
           devCaches?.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th className="l">{t("disk.name")}</th><th className="l">{t("disk.safety")}</th><th>{t("disk.size")}</th><th>{t("disk.files")}</th><th className="l">{t("disk.description")}</th>
              </tr></thead>
              <tbody>
                {devCaches.map((c) => (
                  <tr key={c.id}>
                    <td className="l"><b>{c.name}</b></td>
                    <td className="l"><SafetyBadge level={c.safety} /></td>
                    <td className="mono">{c.size_h}</td>
                    <td className="mono">{fmtN(c.files)}</td>
                    <td className="l" title={(c.paths || []).join("\n")} style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <div className="status">{t("state.noData")}</div>}
        </section>
      )}

      {tab === "ai" && (
        <section className="block">
          <h2>{t("disk.tabAi")}</h2>
          <div className="table-hint" style={{ marginBottom: 8 }}>{t("disk.aiHint")}</div>
          {aiTools === "loading" ? <div className="status">{t("disk.scanning")}</div> :
           aiTools?.length ? (
            <div className="table-wrap"><table>
              <thead><tr>
                <th className="l">{t("disk.tool")}</th><th className="l">{t("disk.kind")}</th><th className="l">{t("disk.safety")}</th><th>{t("disk.size")}</th><th className="l">{t("disk.description")}</th>
              </tr></thead>
              <tbody>
                {aiTools.map((a, i) => (
                  <tr key={i}>
                    <td className="l"><b>{a.tool}</b></td>
                    <td className="l">{a.kind}</td>
                    <td className="l"><SafetyBadge level={a.safety} /></td>
                    <td className="mono">{a.size_h}</td>
                    <td className="l" title={a.path} style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.description}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <div className="status">{t("state.noData")}</div>}
        </section>
      )}

      {tab === "scan" && (
        <section className="block">
          <h2>{t("disk.tabScan")}</h2>
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <input className="key-input mono" style={{ flex: 1, fontFamily: "var(--font-num)" }} placeholder="C:\\Users\\..." value={scanPath} onChange={(e) => setScanPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runScan()} />
            <button type="button" className="btn" disabled={scanning} onClick={runScan}>{scanning ? t("disk.scanning") : t("disk.scanBtn")}</button>
          </div>
          {scanResult && (<>
            <div className="meta" style={{ marginBottom: 8 }}>{scanResult.path} · {scanResult.total_h} · {scanResult.elapsed_ms}ms</div>
            <div className="table-wrap"><table>
              <thead><tr><th className="l">{t("disk.name")}</th><th className="l">{t("disk.type")}</th><th>{t("disk.size")}</th></tr></thead>
              <tbody>
                {(scanResult.items || []).map((item, i) => (
                  <tr key={i}>
                    <td className="l mono" title={item.name}>{item.name}</td>
                    <td className="l">{item.is_dir ? "📁" : "📄"}</td>
                    <td className="mono"><b>{item.size_h}</b></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>)}
        </section>
      )}
    </div>
  );
}

function fmtH(bytes) {
  if (bytes >= 1_099_511_627_776) return (bytes / 1_099_511_627_776).toFixed(1) + " TB";
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + " GB";
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}
function fmtN(n) { return n > 1000 ? (n / 1000).toFixed(1) + "K" : String(n); }

export { DiskIcon };
