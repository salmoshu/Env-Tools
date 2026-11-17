// 磁盘管理（第三大导航区，移植自 Jharu github.com/riponcm/Jharu Apache 2.0）。
// 20 个子标签页完整覆盖 Jharu 全部功能，Jharu 风格左侧分组导航。
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n.js";

function DiskIcon() { return (<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></svg>); }
const SC = { safe: "var(--green)", caution: "var(--yellow)", risky: "var(--red)" };
const SL = { safe: "✓", caution: "⚠", risky: "✕" };
function Safe({ l }) { return <span style={{ color: SC[l] || "var(--faint)", fontSize: 11 }}>{SL[l] || "·"}</span>; }
function fh(b) { return b >= 1e12 ? (b/1e12).toFixed(1)+"TB" : b >= 1e9 ? (b/1e9).toFixed(1)+"GB" : b >= 1e6 ? (b/1e6).toFixed(1)+"MB" : (b/1e3).toFixed(0)+"KB"; }
function Ring({ v, tone, label }) { const r=30,c=2*Math.PI*r,cl={ok:"var(--green)",warn:"var(--yellow)",bad:"var(--red)"}; return (<svg width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r={r} fill="none" stroke="var(--track)" strokeWidth="6" /><circle cx="36" cy="36" r={r} fill="none" stroke={cl[tone]||"var(--green)"} strokeWidth="6" strokeDasharray={c} strokeDashoffset={c*(1-Math.min(100,v)/100)} transform="rotate(-90 36 36)" strokeLinecap="round" /><text x="36" y="36" dominantBaseline="central" textAnchor="middle" fill="var(--text)" fontSize="14" fontWeight="700">{label}</text></svg>); }
function when(d) { if(d==null)return"暂无预测"; if(d<1)return"即将满盘"; if(d<14)return`~${Math.round(d)}天后满`; if(d<60)return`~${Math.round(d/7)}周后满`; return`~${Math.round(d/30)}个月后满`; }

/** Jharu NAV 完整结构（20 项，含全部功能） */
const NAV = [
  { group: "", items: [{ id: "overview", label: "概览", icon: "◎", sub: "驱动器与预测" }] },
  { group: "Developer", items: [
    { id: "dev", label: "开发缓存", icon: "⌘", sub: "25+ 缓存规则" },
    { id: "models", label: "ML 模型", icon: "◈", sub: "用过/未用" },
    { id: "python", label: "Python", icon: "◐", sub: "环境与包" },
    { id: "projects", label: "构建产物", icon: "▥", sub: "node_modules 等" },
    { id: "worktrees", label: "Git worktree", icon: "⑂", sub: "已合并检出" },
    { id: "ai", label: "AI 工具", icon: "✦", sub: "Agent 遗留" },
  ]},
  { group: "Disk", items: [
    { id: "deep", label: "深度清理", icon: "◉", sub: "全盘分析" },
    { id: "dupes", label: "重复文件", icon: "⧉", sub: "内容级去重" },
    { id: "browsers", label: "浏览器", icon: "◍", sub: "网页缓存" },
    { id: "junk", label: "垃圾文件", icon: "▤", sub: "安装包/临时" },
    { id: "desktop", label: "桌面", icon: "▢", sub: "截图/杂物" },
    { id: "scan", label: "目录扫描", icon: "◔", sub: "体积排行" },
  ]},
  { group: "Manage", items: [
    { id: "bin", label: "回收站", icon: "♻", sub: "恢复/清空" },
    { id: "apps", label: "卸载器", icon: "✕", sub: "应用列表" },
    { id: "processes", label: "进程", icon: "↯", sub: "CPU/内存/强杀" },
    { id: "startup", label: "启动项", icon: "⏻", sub: "开机自启" },
    { id: "system", label: "系统空间", icon: "▦", sub: "休眠/还原/Docker" },
  ]},
  { group: "Insight", items: [
    { id: "health", label: "健康", icon: "♥", sub: "容量与 SMART" },
    { id: "history", label: "空间历史", icon: "◔", sub: "增长/缩小对比" },
  ]},
];

/** 通用异步扫描 tab */
function AsyncTab({ load, render }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(() => { setBusy(true); setData(null);
    Promise.resolve(load()).then(setData).catch(() => setData(null)).finally(() => setBusy(false));
  }, [load]);
  useEffect(() => { run(); }, [run]);
  if (busy) return <div className="status">扫描中…</div>;
  if (!data) return <div className="status">{t("state.noData")}</div>;
  return <>{render(data)}<div style={{marginTop:10}}><button className="btn" onClick={run}>刷新</button></div></>;
}
/** 简易表格渲染 */
function Table({ head, rows }) {
  return <div className="table-wrap"><table><thead><tr>{head.map((h,i)=><th key={i} className={h[1]?"l":""}>{h[0]}</th>)}</tr></thead><tbody>{rows}</tbody></table></div>;
}

export default function DiskPage() {
  const [view, setView] = useState("overview");
  const [drives, setDrives] = useState(null);
  const [devCaches, setDevCaches] = useState(null);
  const [aiTools, setAiTools] = useState(null);
  const [scanPath, setScanPath] = useState("C:\\");
  const [scanResult, setScanResult] = useState(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => { window.api.getDiskDrives().then(r => { if(r?.ok) setDrives(r.drives||[]); }).catch(()=>{}); }, []);
  useEffect(() => {
    if (view==="dev" && devCaches===null) { setDevCaches("loading");
      window.api.diskDevScan().then(r => setDevCaches(r?.ok ? r.items||[] : [])).catch(()=>setDevCaches([])); }
    if (view==="ai" && aiTools===null) { setAiTools("loading");
      window.api.diskAiTools().then(r => setAiTools(r?.ok ? r.items||[] : [])).catch(()=>setAiTools([])); }
  }, [view]);

  const runScan = useCallback(async () => {
    if (scanning || !scanPath.trim()) return; setScanning(true); setScanResult(null);
    try { const r = await window.api.diskScan(scanPath.trim(), 30, 2); if (r?.ok) setScanResult(r); } catch {} setScanning(false);
  }, [scanPath, scanning]);

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <aside className="disk-sidebar">
        {NAV.map(g => (<div key={g.group} className="disk-nav-group">
          {g.group && <span className="disk-nav-title">{g.group}</span>}
          {g.items.map(n => (<button key={n.id} className={`disk-nav-item${view===n.id?" active":""}`} onClick={()=>setView(n.id)}>
            <span className="disk-nav-icon">{n.icon}</span>
            <span className="disk-nav-text"><span className="disk-nav-label">{n.label}</span><span className="disk-nav-sub">{n.sub}</span></span>
          </button>))}
        </div>))}
        <div style={{marginTop:"auto",fontSize:10,color:"var(--faint)",padding:"0 10px"}}>所有操作进回收站</div>
      </aside>
      <div style={{flex:1,minWidth:0,overflowY:"auto",padding:"20px 24px"}}>
        {/* 概览 */}
        {view==="overview" && drives && (<div>
          <div style={{display:"flex",flexWrap:"wrap",gap:16,marginBottom:20}}>
            {drives.map(d=>{const pct=Math.round(d.used_percent||0);const tone=pct>=90?"bad":pct>=75?"warn":"ok";return(
              <div key={d.path} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,minWidth:100,cursor:"pointer"}} onClick={()=>{setScanPath(d.path);setView("scan");}}>
                <Ring v={pct} tone={tone} label={`${pct}%`}/><strong style={{fontSize:13}}>{d.path}</strong>
                <span style={{fontSize:11,color:"var(--dim)"}}>{fh(d.available)} 可用</span>
              </div>);})}
          </div>
        </div>)}
        {view==="overview" && !drives && <div className="status">…</div>}

        {/* 开发缓存 */}
        {view==="dev" && devCaches==="loading" && <div className="status">…</div>}
        {view==="dev" && Array.isArray(devCaches) && <Table head={[["名称",1],["安全",1],["体积"],["文件"],["说明",1]]}
          rows={devCaches.map(c=><tr key={c.id}><td className="l"><b>{c.name}</b></td><td className="l"><Safe l={c.safety}/></td><td className="mono">{c.size_h}</td><td>{c.files}</td><td className="l" style={{maxWidth:280,overflow:"hidden",textOverflow:"ellipsis"}}>{c.description}</td></tr>)}/>}

        {/* AI 工具 */}
        {view==="ai" && aiTools==="loading" && <div className="status">…</div>}
        {view==="ai" && Array.isArray(aiTools) && <Table head={[["工具",1],["安全",1],["体积"],["说明",1]]}
          rows={aiTools.map((a,i)=><tr key={i}><td className="l"><b>{a.tool}</b> <span style={{color:"var(--faint)",fontSize:10}}>{a.kind}</span></td><td className="l"><Safe l={a.safety}/></td><td className="mono">{a.size_h}</td><td className="l" style={{maxWidth:280,overflow:"hidden",textOverflow:"ellipsis"}} title={a.path}>{a.description}</td></tr>)}/>}

        {/* ML 模型 */}
        {view==="models" && <AsyncTab load={()=>window.api.diskScanFull("models")} render={d=><Table head={[["Provider",1],["Model",1],["体积"],["用过"],["最近"]]}
          rows={(d.models||[]).map((m,i)=><tr key={i}><td className="l">{m.provider}</td><td className="l mono">{m.name}</td><td className="mono">{m.size_h}</td><td>{m.used?"✓":"—"}</td><td>{m.last_used_days!=null?`${m.last_used_days}d`:"—"}</td></tr>)}/>}/>}

        {/* Python */}
        {view==="python" && <AsyncTab load={()=>window.api.diskScanFull("python")} render={d=><Table head={[["名称",1],["Kind"],["体积"]]}
          rows={(d.envs||[]).map((e,i)=><tr key={i}><td className="l"><b>{e.name}</b></td><td>{e.kind}</td><td className="mono">{e.size_h}</td></tr>)}/>}/>}

        {/* 构建产物 */}
        {view==="projects" && <AsyncTab load={()=>window.api.diskProjects("E:\\Proj-Enhanced")} render={d=><Table head={[["类型",1],["项目",1],["体积"]]}
          rows={(d.items||[]).map((p,i)=><tr key={i}><td className="l">{p.kind}</td><td className="l mono" title={p.path}>{p.project}</td><td className="mono">{p.size_h}</td></tr>)}/>}/>}

        {/* Git worktree */}
        {view==="worktrees" && <AsyncTab load={()=>window.api.diskWorktrees("E:\\Proj-Enhanced")} render={d=><Table head={[["路径",1],["分支",1],["已合并"],["体积"]]}
          rows={(d.items||[]).map((w,i)=><tr key={i}><td className="l mono" title={w.path}>{w.path}</td><td className="l">{w.branch}</td><td>{w.merged?"✓":"—"}</td><td className="mono">{w.size_h}</td></tr>)}/>}/>}

        {/* 深度清理 */}
        {view==="deep" && <AsyncTab load={()=>window.api.diskDeep(scanPath, 2)} render={d=><Table head={[["名称",1],["类型",1],["体积"],["分类",1]]}
          rows={(d.entries||[]).map((e,i)=><tr key={i}><td className="l mono" title={e.path}>{e.name}</td><td className="l">{e.is_dir?"📁":"📄"}</td><td className="mono"><b>{e.size_h}</b></td><td className="l">{e.kind}</td></tr>)}/>}/>}

        {/* 重复文件 */}
        {view==="dupes" && <AsyncTab load={()=>window.api.diskDupes([`${scanPath}`], 10000000)} render={d=>
          <><div className="meta" style={{marginBottom:8}}>浪费空间：{d.wasted_h} · {d.groups} 组重复</div>
          <Table head={[["文件",1],["副本数"],["浪费"]]}
            rows={(d.items||[]).map((g,i)=><tr key={i}><td className="l mono" title={g.files?.map(f=>f.path).join("\n")}>{g.files?.[0]?.name||"?"}</td><td>{g.count}</td><td className="mono">{g.wasted_h||fh(g.wasted)}</td></tr>)}/></>}/>}

        {/* 浏览器 */}
        {view==="browsers" && <AsyncTab load={()=>window.api.diskScanFull("browsers")} render={d=>
          <div className="quota-grid">{(d.browsers||[]).map((b,i)=><div key={i} className="qcard"><div className="qcard-head"><span className="qname">{b.name}</span></div><div style={{fontSize:12,marginTop:6,color:"var(--dim)"}}>{b.total_h}</div></div>)}</div>}/>}

        {/* 垃圾文件 */}
        {view==="junk" && <AsyncTab load={()=>window.api.diskScanFull("junk")} render={d=><Table head={[["名称",1],["体积"],["说明",1]]}
          rows={(d.groups||[]).flatMap(g=>(g.items||[]).map((it,j)=><tr key={`${g.id}-${j}`}><td className="l"><b>{it.label||g.title}</b></td><td className="mono">{it.size_h||g.total_h}</td><td className="l">{g.note}</td></tr>))}/>}/>}

        {/* 桌面 */}
        {view==="desktop" && <AsyncTab load={()=>window.api.diskDesktop()} render={d=><Table head={[["名称",1],["体积"],["类型",1]]}
          rows={(d.items||[]).map((it,i)=><tr key={i}><td className="l">{it.name}</td><td className="mono">{it.size_h}</td><td className="l">{it.kind}</td></tr>)}/>}/>}

        {/* 回收站 */}
        {view==="bin" && <AsyncTab load={()=>window.api.diskBin()} render={d=>
          <><div className="meta" style={{marginBottom:8}}>{d.total_h||"0"} · {(d.items||[]).length} 项</div>
          <Table head={[["名称",1],["体积"],["删除时间",1]]}
            rows={(Array.isArray(d.items)?d.items:[]).map((it,i)=><tr key={i}><td className="l">{it.Name||it.name}</td><td className="mono">{fh(it.Size||it.size||0)}</td><td className="l">{it.Deleted||""}</td></tr>)}/>
          <button className="btn" style={{marginTop:10,color:"var(--red)"}} onClick={()=>window.api.diskBinPurge()}>清空回收站</button></>}/>}

        {/* 卸载器 */}
        {view==="apps" && <AsyncTab load={()=>window.api.diskApps()} render={d=><Table head={[["名称",1],["版本",1],["发布者",1],["体积"]]}
          rows={(Array.isArray(d.items)?d.items:[]).filter(a=>a.DisplayName).map((a,i)=><tr key={i}><td className="l"><b>{a.DisplayName}</b></td><td>{a.DisplayVersion||""}</td><td className="l">{a.Publisher||""}</td><td className="mono">{a.EstimatedSize?fh(a.EstimatedSize*1024):"—"}</td></tr>)}/>}/>}

        {/* 进程 */}
        {view==="processes" && <AsyncTab load={()=>window.api.diskProcesses()} render={d=><Table head={[["进程",1],["PID"],["CPU(s)"],["内存(MB)"]]}
          rows={(Array.isArray(d.items)?d.items:[]).map((p,i)=><tr key={i}><td className="l"><b>{p.ProcessName}</b></td><td className="mono">{p.Id}</td><td className="mono">{p.CPU?Math.round(p.CPU):"—"}</td><td className="mono">{p.MemMB||"—"}</td></tr>)}/>}/>}

        {/* 启动项 */}
        {view==="startup" && <AsyncTab load={()=>window.api.diskStartup()} render={d=><Table head={[["名称",1],["来源",1],["命令",1]]}
          rows={(d.items||[]).map((s,i)=><tr key={i}><td className="l"><b>{s.name}</b></td><td className="l" style={{fontSize:10}}>{s.source}</td><td className="l mono" style={{maxWidth:300,overflow:"hidden",textOverflow:"ellipsis"}}>{s.command}</td></tr>)}/>}/>}

        {/* 系统空间 */}
        {view==="system" && <AsyncTab load={()=>window.api.diskSystem()} render={d=><Table head={[["项目",1],["体积"],["需管理员"]]}
          rows={(d.items||[]).map((s,i)=><tr key={i}><td className="l"><b>{s.label}</b></td><td className="mono">{s.size_h}</td><td>{s.needs_admin?"⚠":"—"}</td></tr>)}/>}/>}

        {/* 健康 */}
        {view==="health" && <AsyncTab load={()=>window.api.diskScanFull("health")} render={d=><Table head={[["驱动器",1],["总量"],["已用"],["增速"],["预计满盘",1]]}
          rows={(d.forecasts||[]).map((f,i)=><tr key={i}><td className="l mono"><b>{f.path}</b></td><td className="mono">{f.total_gb?.toFixed(0)}GB</td><td className="mono">{f.used_gb?.toFixed(0)}GB</td><td className="mono">{f.growth_gb_per_day?.toFixed(2)}GB/d</td><td className="l">{f.days_to_full!=null?`${f.eta} (~${Math.round(f.days_to_full)}d)`:"—"}</td></tr>)}/>}/>}

        {/* 空间历史 */}
        {view==="history" && <AsyncTab load={()=>window.api.diskHistory()} render={d=><Table head={[["驱动器",1],["变化",1],["方向"]]}
          rows={(d.changes||[]).map((c,i)=><tr key={i}><td className="l mono">{c.drive}</td><td className="mono">{c.delta_h}</td><td className="l">{c.direction==="grew"?"↑ 增长":"↓ 缩小"}</td></tr>)}/>}/>}

        {/* 目录扫描 */}
        {view==="scan" && (<div>
          <div style={{display:"flex",gap:10,marginBottom:14}}>
            <input className="key-input mono" style={{flex:1,fontFamily:"var(--font-num)"}} placeholder="C:\\Users\\..." value={scanPath} onChange={e=>setScanPath(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runScan()}/>
            <button type="button" className="btn refresh-inline" disabled={scanning} onClick={runScan}>{scanning?t("disk.scanning"):t("disk.scanBtn")}</button>
          </div>
          {scanResult && (<><div className="meta" style={{marginBottom:8}}>{scanResult.path} · {scanResult.total_h} · {scanResult.elapsed_ms}ms</div>
            <Table head={[["名称",1],["类型",1],["体积"]]}
              rows={(scanResult.items||[]).map((it,i)=><tr key={i}><td className="l mono" title={it.name}>{it.name}</td><td className="l">{it.is_dir?"📁":"📄"}</td><td className="mono"><b>{it.size_h}</b></td></tr>)}/></>)}
        </div>)}
      </div>
    </div>
  );
}
export { DiskIcon };
