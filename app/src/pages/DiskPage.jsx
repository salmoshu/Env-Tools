// 磁盘管理（第三大导航区）：驱动器概览 + 目录体积排行。
// 参考 Jharu（github.com/riponcm/Jharu）的开发者磁盘清理理念——
// 识别"什么最占空间"，为后续清理决策提供数据。
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

export default function DiskPage() {
  const [drives, setDrives] = useState(null);
  const [scanPath, setScanPath] = useState("C:\\");
  const [scanResult, setScanResult] = useState(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    window.api.getDiskDrives().then((r) => {
      if (r && r.ok) setDrives(r.drives || []);
    }).catch(() => {});
  }, []);

  const runScan = useCallback(async () => {
    if (scanning || !scanPath.trim()) return;
    setScanning(true);
    setScanResult(null);
    try {
      const r = await window.api.diskScan(scanPath.trim(), 30, 2);
      if (r && r.ok) setScanResult(r);
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

      {/* 驱动器概览 */}
      <section className="block">
        <h2>{t("disk.drives")}</h2>
        {!drives ? <div className="status">…</div> : (
          <div className="quota-grid">
            {drives.map((d) => (
              <div key={d.path} className="qcard" style={{ cursor: "pointer" }}
                onClick={() => setScanPath(d.path)}
                title={t("disk.scanThis")}
              >
                <div className="qcard-head">
                  <span className="qname mono">{d.path}</span>
                </div>
                <div className="qquota">
                  <div className="qrow">
                    <span>{t("disk.used")}</span>
                    <span className="pct">{d.used_percent}%</span>
                  </div>
                  <div className="bar">
                    <div className={`fill ${d.used_percent > 85 ? "high" : d.used_percent > 60 ? "mid" : "low"}`}
                      style={{ width: `${d.used_percent}%` }} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>
                    {fmtH(d.used)} / {fmtH(d.total)} · {t("disk.free")} {fmtH(d.available)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 目录体积排行 */}
      <section className="block">
        <h2>{t("disk.scanTitle")}</h2>
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <input
            className="key-input mono"
            style={{ flex: 1, fontFamily: "var(--font-num)" }}
            placeholder="C:\Users\..."
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runScan()}
          />
          <button type="button" className="btn" disabled={scanning} onClick={runScan}>
            {scanning ? t("disk.scanning") : t("disk.scanBtn")}
          </button>
        </div>
        {scanResult && (
          <>
            <div className="meta" style={{ marginBottom: 8 }}>
              {scanResult.path} · {scanResult.total_h} · {scanResult.elapsed_ms}ms
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th className="l">{t("disk.name")}</th><th className="l">{t("disk.type")}</th><th>{t("disk.size")}</th></tr>
                </thead>
                <tbody>
                  {(scanResult.items || []).map((item, i) => (
                    <tr key={i}>
                      <td className="l mono" title={item.name}>{item.name}</td>
                      <td className="l">{item.is_dir ? "📁" : "📄"}</td>
                      <td className="mono"><b>{item.size_h}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function fmtH(bytes) {
  if (bytes >= 1_099_511_627_776) return (bytes / 1_099_511_627_776).toFixed(1) + " TB";
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + " GB";
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

export { DiskIcon };
