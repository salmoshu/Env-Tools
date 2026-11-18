// 磁盘管理（第三大导航区，移植自 Jharu github.com/riponcm/Jharu Apache 2.0）。
// 20 个子标签页完整覆盖 Jharu 全部功能；扫描 → 选择 → 清理（进回收站+记
// 日志）→ 回收站恢复/范围清空 全链路可用。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n.js";
import { squarify } from "../components/squarify.js";

function DiskIcon() { return (<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></svg>); }
const SC = { safe: "var(--green)", caution: "var(--yellow)", risky: "var(--red)" };
const SL = { safe: "✓", caution: "⚠", risky: "✕" };
function Safe({ l }) { return <span style={{ color: SC[l] || "var(--faint)", fontSize: 11 }}>{SL[l] || "·"}</span>; }
function fh(b) { return b >= 1e12 ? (b/1e12).toFixed(1)+"TB" : b >= 1e9 ? (b/1e9).toFixed(1)+"GB" : b >= 1e6 ? (b/1e6).toFixed(1)+"MB" : b >= 1e3 ? (b/1e3).toFixed(0)+"KB" : (b||0)+"B"; }
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
    { id: "sandboxes", label: "应用沙箱", icon: "◫", sub: "商店应用私有目录" },
    { id: "browsers", label: "浏览器", icon: "◍", sub: "网页缓存" },
    { id: "junk", label: "垃圾文件", icon: "▤", sub: "安装包/临时" },
    { id: "desktop", label: "桌面", icon: "▢", sub: "截图/杂物" },
    { id: "scan", label: "目录扫描", icon: "◔", sub: "体积排行" },
  ]},
  { group: "Manage", items: [
    { id: "bin", label: "回收站", icon: "♻", sub: "恢复/清空" },
    { id: "apps", label: "卸载器", icon: "✕", sub: "应用列表" },
    { id: "processes", label: "进程", icon: "↯", sub: "CPU/内存" },
    { id: "startup", label: "启动项", icon: "⏻", sub: "开机自启" },
    { id: "system", label: "系统空间", icon: "▦", sub: "休眠/还原/Docker" },
  ]},
  { group: "Insight", items: [
    { id: "health", label: "健康", icon: "♥", sub: "容量与 SMART" },
    { id: "history", label: "空间历史", icon: "◔", sub: "增长/缩小对比" },
    { id: "autocare", label: "自动养护", icon: "⏱", sub: "定时安全清理" },
  ]},
];

/** 通用异步扫描 tab；reloadKey 变化时强制重扫（清理后刷新用） */
function AsyncTab({ load, render, reloadKey }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadRef = useRef(load); loadRef.current = load;
  const run = useCallback(() => { setBusy(true); setData(null);
    Promise.resolve(loadRef.current()).then(setData).catch(() => setData(null)).finally(() => setBusy(false));
  }, []);
  useEffect(() => { run(); }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey > 0) run(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (busy) return <div className="status">扫描中…</div>;
  if (!data) return <div className="status">{t("state.noData")}</div>;
  return <>{render(data)}<div style={{marginTop:10}}><button className="btn" onClick={run}>刷新</button></div></>;
}
/** 简易表格渲染 */
function Table({ head, rows }) {
  return <div className="table-wrap"><table><thead><tr>{head.map((h,i)=><th key={i} className={h[1]?"l":""} style={h[2]?{width:h[2]}:undefined}>{h[0]}</th>)}</tr></thead><tbody>{rows}</tbody></table></div>;
}

// ============================================================ 清理选择

/** 行选择状态：以 path 为键 */
function useSel() {
  const [sel, setSel] = useState(() => new Set());
  const toggle = useCallback((p) => setSel(prev => {
    const n = new Set(prev);
    if (n.has(p)) n.delete(p); else n.add(p);
    return n;
  }), []);
  const setAll = useCallback((paths, on) => setSel(() => new Set(on ? paths : [])), []);
  const clear = useCallback(() => setSel(new Set()), []);
  return { sel, toggle, setAll, clear };
}

/** 清理操作条：已选 N 项 · [清理选中] → 后台任务 + 进度条 + 取消按钮 */
function CleanBar({ sel, items, onDone, source, extraWarn }) {
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null); // {job, done, total, current, state}
  const [result, setResult] = useState(null);
  const selItems = useMemo(() => items.filter(it => sel.has(it.path)), [items, sel]);
  const selBytes = selItems.reduce((s, it) => s + (it.size || 0), 0);
  const hasRisky = selItems.some(it => it.safety === "risky");
  const doClean = useCallback(async () => {
    if (!selItems.length || busy) return;
    const riskyN = selItems.filter(it => it.safety === "risky").length;
    if (riskyN > 0 && !window.confirm(`选中项含 ${riskyN} 个不可自动恢复的目标（Risky），确认移入回收站？`)) return;
    if (selItems.length > 8 && !window.confirm(`将 ${selItems.length} 项（${fh(selBytes)}）移入回收站？`)) return;
    setBusy(true); setResult(null);
    try {
      const r = await window.api.cleanStart(selItems.map(it => ({ path: it.path, size: it.size })), source);
      if (!r?.ok) { setResult(r); setBusy(false); return; }
      setProg({ job: r.job, done: 0, total: selItems.length, current: "", state: "running" });
      const timer = window.setInterval(async () => {
        try {
          const p = await window.api.cleanProgress(r.job);
          if (!p?.ok) { window.clearInterval(timer); setProg(null); setBusy(false); setResult(p); return; }
          setProg(p);
          if (p.state !== "running") {
            window.clearInterval(timer);
            setProg(null); setBusy(false);
            setResult(p.result || p);
            if (p.result?.ok) onDone?.();
          }
        } catch { window.clearInterval(timer); setProg(null); setBusy(false); }
      }, 400);
    } catch (e) { setResult({ ok: false, error: e.message }); setBusy(false); }
  }, [selItems, selBytes, busy, onDone, source]);
  const cancelClean = useCallback(() => { if (prog?.job) window.api.cleanCancel(prog.job).catch(() => {}); }, [prog]);
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
  return (<div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
    <span className="meta">已选 {selItems.length} 项 · {fh(selBytes)}</span>
    {!prog && <button className="btn" disabled={busy || !selItems.length} onClick={doClean} style={hasRisky ? {color:"var(--red)"}:undefined}>
      {busy ? "清理中…" : "清理选中（→回收站）"}
    </button>}
    {hasRisky && !prog && <span style={{fontSize:11,color:"var(--red)"}}>含 Risky 项，删除前请确认</span>}
    {extraWarn && !prog && <span style={{fontSize:11,color:"var(--yellow)"}}>{extraWarn}</span>}
    {prog && (<div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:260}}>
      <div style={{flex:1,height:8,background:"var(--track)",borderRadius:999,overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",background:"var(--accent)",transition:"width .3s"}}/>
      </div>
      <span className="meta" style={{whiteSpace:"nowrap"}}>{prog.done}/{prog.total}{prog.current ? ` · ${prog.current}` : ""}</span>
      <button className="btn" style={{height:24,padding:"0 10px",fontSize:11}} onClick={cancelClean}>取消</button>
    </div>)}
    {result && <span className="meta" style={{color: result.ok ? "var(--green)" : "var(--red)"}}>
      {result.ok ? `已移入 ${result.moved} 项，释放 ${result.freed_h}` : `失败：${result.error || (result.failed||[]).join("；")}${result.cancelled ? "（已取消）" : ""}`}
    </span>}
  </div>);
}

/** 复选框单元格 */
function Check({ on, onChange }) {
  return <td><input type="checkbox" checked={on} onChange={onChange} style={{accentColor:"var(--km-blue, #1783FF)",cursor:"pointer"}}/></td>;
}

/**
 * 通用"可清理列表" tab：load 取数 → itemsOf(data) 归一为
 * [{path,size,label,safety}] → 复选框选择 → CleanBar 清理 → 清理后强制重扫。
 * head: 除复选框外的表头 [["名称",1],["体积"]]；row(it) 返回同列数的 <td>。
 */
function CleanableTab({ load, reloadKey, itemsOf, source, extraWarn, meta, head, row }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const { sel, toggle, setAll } = useSel();
  const loadRef = useRef(load); loadRef.current = load;
  const itemsOfRef = useRef(itemsOf); itemsOfRef.current = itemsOf;
  const run = useCallback(() => {
    setBusy(true); setData(null);
    Promise.resolve(loadRef.current()).then(d => { setData(d); setAll([], false); }).catch(() => setData(null)).finally(() => setBusy(false));
  }, [setAll]);
  useEffect(() => { run(); }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey > 0) run(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => (data && Array.isArray(itemsOfRef.current(data))) ? itemsOfRef.current(data) : [], [data]);
  const allOn = items.length > 0 && items.every(it => sel.has(it.path));
  if (busy && !data) return <div className="status">扫描中…</div>;
  if (!data) return <div className="status">{t("state.noData")}</div>;
  const metaText = typeof meta === "function" ? meta(data) : meta;
  return (<div>
    {metaText ? <div className="meta" style={{marginBottom:8}}>{metaText}</div> : null}
    <CleanBar sel={sel} items={items} source={source} extraWarn={extraWarn} onDone={run}/>
    <div className="table-wrap"><table>
      <thead><tr>
        <th><input type="checkbox" checked={allOn} onChange={e => setAll(items.map(it => it.path), e.target.checked)} style={{accentColor:"var(--km-blue, #1783FF)",cursor:"pointer"}}/></th>
        {head.map((h,i)=><th key={i} className={h[1]?"l":""}>{h[0]}</th>)}
      </tr></thead>
      <tbody>{items.map((it,i)=><tr key={i}>
        <Check on={sel.has(it.path)} onChange={() => toggle(it.path)}/>
        {row(it)}
      </tr>)}</tbody>
    </table></div>
    <div style={{marginTop:10}}><button className="btn" onClick={run}>刷新</button></div>
  </div>);
}

// ============================================================ 回收站 tab

const PURGE_SCOPES = [
  { id: "all", label: "全部" },
  { id: "older", label: "超过 30 天" },
  { id: "app_older", label: "仅本应用移入·超30天" },
];

function BinTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(null);
  const [scope, setScope] = useState("all");
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => {
    setBusy(true);
    try { const r = await window.api.diskBin(); setData(r); } catch { setData(null); }
    setBusy(false);
  }, []);
  const loadLog = useCallback(async () => {
    try { setLog(await window.api.diskBinLog()); } catch { setLog(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadLog(); }, [loadLog]);

  const items = Array.isArray(data?.items) ? data.items : [];
  const [purgeProg, setPurgeProg] = useState(null);
  const doPurge = useCallback(async () => {
    const sc = PURGE_SCOPES.find(s => s.id === scope);
    const target = scope === "all" ? items.length : items.filter(i => scope === "app_older" ? i.by_app && (i.age_days||0) >= 30 : (i.age_days||0) >= 30).length;
    if (!window.confirm(`永久删除 ${target} 项（${sc.label}）？此操作不可恢复，不经过回收站。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await window.api.diskBinPurgeStart({ ids: items.map(i => ({ id: i.id, deleted: i.deleted_at })), scope, days: 30 });
      if (!r?.ok) { setMsg(r); setBusy(false); return; }
      setPurgeProg({ job: r.job, done: 0, total: target, current: "", state: "running" });
      const timer = window.setInterval(async () => {
        try {
          const p = await window.api.cleanProgress(r.job);
          if (!p?.ok) { window.clearInterval(timer); setPurgeProg(null); setBusy(false); setMsg(p); return; }
          setPurgeProg(p);
          if (p.state !== "running") {
            window.clearInterval(timer);
            setPurgeProg(null); setBusy(false);
            setMsg(p.result || p);
            await load();
          }
        } catch { window.clearInterval(timer); setPurgeProg(null); setBusy(false); }
      }, 400);
    } catch (e) { setMsg({ ok: false, error: e.message }); setBusy(false); }
  }, [scope, items, load]);
  const doRestore = useCallback(async (id) => {
    setBusy(true); setMsg(null);
    try {
      const r = await window.api.diskBinRestore([id]);
      setMsg(r);
      await load(); await loadLog();
    } catch (e) { setMsg({ ok: false, error: e.message }); }
    setBusy(false);
  }, [load, loadLog]);

  if (busy && !data) return <div className="status">读取回收站…</div>;
  if (!data?.ok && !data?.items) return <div className="status">{data?.error || "无法读取回收站"}</div>;
  return (<div>
    <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:14}}>
      <div className="qcard" style={{minWidth:150,padding:"10px 14px"}}><div style={{fontSize:11,color:"var(--dim)"}}>合计</div><b>{data.total_h||"0"}</b><span style={{fontSize:11,color:"var(--dim)"}}> · {data.total_items} 项</span></div>
      <div className="qcard" style={{minWidth:150,padding:"10px 14px"}}><div style={{fontSize:11,color:"var(--dim)"}}>本应用移入 <Safe l="safe"/></div><b style={{color:"var(--green)"}}>{fh(data.app_bytes||0)}</b><span style={{fontSize:11,color:"var(--dim)"}}> · {data.app_items} 项</span></div>
      <div className="qcard" style={{minWidth:150,padding:"10px 14px"}}><div style={{fontSize:11,color:"var(--dim)"}}>你自己删除 <Safe l="caution"/></div><b style={{color:"var(--yellow)"}}>{fh(data.other_bytes||0)}</b><span style={{fontSize:11,color:"var(--dim)"}}> · {data.other_items} 项</span></div>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
      <span style={{fontSize:12,color:"var(--dim)"}}>清空范围</span>
      <select className="key-input" value={scope} onChange={e => setScope(e.target.value)} style={{padding:"4px 8px"}}>
        {PURGE_SCOPES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <button className="btn" disabled={busy || !items.length} style={{color:"var(--red)"}} onClick={doPurge}>永久清空…</button>
      <button className="btn" onClick={load} disabled={busy}>刷新</button>
    </div>
    {purgeProg && (<div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
      <div style={{flex:1,height:8,background:"var(--track)",borderRadius:999,overflow:"hidden",maxWidth:420}}>
        <div style={{width:`${purgeProg.total>0?Math.round(purgeProg.done/purgeProg.total*100):0}%`,height:"100%",background:"var(--red)",transition:"width .3s"}}/>
      </div>
      <span className="meta">{purgeProg.done}/{purgeProg.total}{purgeProg.current?` · ${purgeProg.current}`:""}</span>
      <button className="btn" style={{height:24,padding:"0 10px",fontSize:11}} onClick={()=>window.api.cleanCancel(purgeProg.job).catch(()=>{})}>取消</button>
    </div>)}
    {msg && <div className="meta" style={{marginBottom:8,color: msg.ok===false ? "var(--red)" : "var(--green)"}}>
      {msg.ok===false ? `失败：${(msg.errors||[]).join("；")||msg.error}` : msg.purged != null ? `已永久删除 ${msg.purged} 项，释放 ${msg.freed_h}${msg.skipped?.length?`；跳过 ${msg.skipped.length} 项`:""}` : msg.restored ? `已还原 ${msg.restored.length} 项${msg.skipped?.length?`；跳过：${msg.skipped[0]}`:""}` : JSON.stringify(msg).slice(0,120)}
    </div>}
    <Table head={[["名称",1],["安全"],["体积"],["删除于",1],["来源",1],[""]]}
      rows={items.map((it,i)=><tr key={i}>
        <td className="l"><b>{it.name}</b>{it.is_dir?" 📁":""} <span style={{fontSize:10,color:"var(--faint)"}} title={it.original_path}>{it.original_folder||""}</span></td>
        <td><Safe l={it.safety}/></td>
        <td className="mono">{it.size_h}</td>
        <td className="l" style={{fontSize:11}}>{it.age_days!=null?`${it.age_days} 天前`:"—"}{it.by_app?` · ${it.source}`:""}</td>
        <td className="l" style={{fontSize:11,color:"var(--dim)"}}>{it.summary}</td>
        <td><button className="btn" style={{fontSize:11,padding:"2px 8px"}} disabled={busy} onClick={()=>doRestore(it.id)}>还原</button></td>
      </tr>)}/>
    {/* 清理日志 */}
    <div style={{marginTop:24}}>
      <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>清理日志（最近 {log?.entries?.length||0} 条 / 共 {log?.total_logged||0} 条）</div>
      <div style={{fontSize:11,color:"var(--dim)",marginBottom:6}}>本应用每次移入回收站都会记录；仍在站内的条目可一键还原。</div>
      <Table head={[["文件",1],["来源",1],["体积"],["时间",1],[""]]}
        rows={(log?.entries||[]).map((e,i)=><tr key={i}>
          <td className="l mono" title={e.path} style={{maxWidth:320,overflow:"hidden",textOverflow:"ellipsis"}}>{e.name}</td>
          <td className="l" style={{fontSize:11}}>{e.source}</td>
          <td className="mono">{e.size_h}</td>
          <td className="l" style={{fontSize:11}}>{new Date(e.time*1000).toLocaleString()}</td>
          <td>{e.in_bin ? <button className="btn" style={{fontSize:11,padding:"2px 8px"}} disabled={busy} onClick={()=>doRestore(e.bin_id)}>还原</button> : <span style={{fontSize:10,color:"var(--faint)"}}>{e.destination_taken?"目标已被占用":"已离开回收站"}</span>}</td>
        </tr>)}/>
    </div>
  </div>);
}

// ============================================================ 卸载器 tab

function AppsTab() {
  return <AsyncTab load={()=>window.api.diskApps()} render={d=>{
    const apps = (d.items||[]);
    const uninstall = async (a) => {
      if (!a.uninstall_command) return;
      if (!window.confirm(`运行「${a.name}」自带的卸载程序？\n${a.uninstall_command.slice(0,120)}`)) return;
      const r = await window.api.diskAppUninstall(a.uninstall_command);
      if (!r?.ok) window.alert(`启动失败：${r?.error||r?.failed||"未知错误"}`);
    };
    return <Table head={[["名称",1],["版本",1],["发布者",1],["程序"],["数据"],[""]]}
      rows={apps.map((a,i)=><tr key={i}>
        <td className="l"><b>{a.name}</b></td>
        <td style={{fontSize:11}}>{a.version||"—"}</td>
        <td className="l" style={{fontSize:11}}>{a.publisher||"—"}</td>
        <td className="mono">{a.size_h}</td>
        <td className="mono" title="AppData 等处的数据目录">{a.data_h}</td>
        <td>{a.uninstall_command ? <button className="btn" style={{fontSize:11,padding:"2px 8px",color:"var(--red)"}} onClick={()=>uninstall(a)}>卸载</button> : <span style={{fontSize:10,color:"var(--faint)"}}>无卸载命令</span>}</td>
      </tr>)}/>;
  }}/>;
}

// ============================================================ 启动项 tab

function StartupTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState("all");
  const load = useCallback(async () => {
    setBusy(true);
    try { setData(await window.api.diskStartup()); } catch { setData(null); }
    setBusy(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  const setEnabled = useCallback(async (entry, enable) => {
    setBusy(true); setMsg(null);
    try {
      const r = await window.api.diskStartupSet([entry.id], enable);
      setMsg(r);
      await load();
    } catch (e) { setMsg({ ok:false, error:e.message }); }
    setBusy(false);
  }, [load]);
  if (busy && !data) return <div className="status">扫描启动项…</div>;
  const entries = (data?.entries||[]).filter(e => filter==="all" ? true : filter==="on" ? e.enabled!==false : e.enabled===false);
  return (<div>
    <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
      <span className="meta">{entries.length} 项（另隐去 {data?.hidden_system_tasks||0} 个 Windows 系统计划任务）</span>
      <select className="key-input" value={filter} onChange={e=>setFilter(e.target.value)} style={{padding:"4px 8px"}}>
        <option value="all">全部</option><option value="on">已启用</option><option value="off">已关闭</option>
      </select>
      <button className="btn" onClick={load} disabled={busy}>重新扫描</button>
    </div>
    {msg && <div className="meta" style={{marginBottom:8,color: msg.ok?"var(--green)":"var(--red)"}}>
      {msg.ok ? `已更改 ${(msg.changed||[]).length} 项${(msg.skipped||[]).length?`；跳过：${msg.skipped[0]?.why||""}`:""}` : (msg.errors||[]).join("；")||msg.error}
    </div>}
    <Table head={[["名称",1],["影响"],["开关"],["类型",1],["发布者/命令",1],["评级",1]]}
      rows={entries.map((s,i)=><tr key={i}>
        <td className="l"><b>{s.name}</b>{s.running ? <span style={{fontSize:10,color:"var(--green)"}}> 运行中</span> : null}</td>
        <td className="l" style={{fontSize:10,color:"var(--dim)"}}>{s.impact?.text?.replace("估计：","")}</td>
        <td>{s.can_toggle
          ? <button className="btn" style={{fontSize:11,padding:"2px 10px",opacity:s.enabled===false?.55:1}} disabled={busy||s.safety==="risky"&&s.enabled!==false}
              title={s.safety==="risky"&&s.enabled!==false ? "受保护项不会关闭（可重新开启）" : s.needs_admin ? "机器级条目，可能需要管理员" : ""}
              onClick={()=>setEnabled(s, s.enabled===false)}>
              {s.enabled===false ? "已关 · 开启" : "开 · 关闭"}
            </button>
          : <span style={{fontSize:10,color:"var(--faint)"}}>只读</span>}</td>
        <td className="l" style={{fontSize:11}}>{s.kind_label}</td>
        <td className="l" style={{fontSize:10,maxWidth:300,overflow:"hidden",textOverflow:"ellipsis"}} title={`${s.publisher||""}\n${s.command}`}>{s.publisher ? `${s.publisher} · ` : ""}<span className="mono">{s.command}</span></td>
        <td><Safe l={s.safety}/> <span style={{fontSize:10,color:"var(--dim)"}}>{s.summary}</span></td>
      </tr>)}/>
  </div>);
}

// ============================================================ 系统空间 tab

function SystemTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => {
    setBusy(true);
    try { setData(await window.api.diskSystem()); } catch { setData(null); }
    setBusy(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = useCallback(async (action, shadow) => {
    const label = action === "list-restore-points" ? "检查还原点（会弹 UAC）"
      : action === "analyze-component-store" ? "分析组件仓库（管理员，1-2 分钟）"
      : `执行 ${action}（管理员，可能不可逆）`;
    if (!window.confirm(`${label}？`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await window.api.diskSystemAction(action, shadow);
      setMsg(r);
      await load();
    } catch (e) { setMsg({ ok:false, error:e.message }); }
    setBusy(false);
  }, [load]);
  if (busy && !data) return <div className="status">读取系统空间…</div>;
  return (<div>
    {msg && <div className="meta" style={{marginBottom:10,color: msg.ok?"var(--green)":"var(--red)",whiteSpace:"pre-wrap",maxHeight:140,overflow:"auto"}}>
      {msg.ok ? `完成。输出：\n${(msg.output||"").slice(0,600)}` : msg.error}
    </div>}
    {(data?.items||[]).map(it=><div key={it.id} className="qcard" style={{marginBottom:14,padding:"14px 16px"}}>
      <div style={{display:"flex",gap:10,alignItems:"baseline",flexWrap:"wrap"}}>
        <b style={{fontSize:14}}>{it.title}</b>
        <span className="mono" style={{color:"var(--km-blue,#1783FF)"}}>{it.size_h}</span>
        {it.info_only && <span style={{fontSize:10,color:"var(--faint)",border:"1px solid var(--track)",borderRadius:4,padding:"1px 6px"}}>仅信息</span>}
      </div>
      <div style={{fontSize:12,color:"var(--dim)",margin:"6px 0"}}>{it.summary}</div>
      {it.size_note && <div style={{fontSize:11,color:"var(--yellow)",marginBottom:6}}>{it.size_note}</div>}
      {it.notice && <div style={{fontSize:11,color:"var(--yellow)",marginBottom:6}}>{it.notice}</div>}
      {(it.facts||[]).length>0 && <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:4,margin:"6px 0"}}>
        {(it.facts||[]).map((f,i)=><div key={i} style={{fontSize:11}}><span style={{color:"var(--faint)"}}>{f.label}：</span>{f.text}</div>)}
      </div>}
      {it.how_to && <div style={{fontSize:11,color:"var(--dim)",margin:"6px 0"}}>👉 {it.how_to}</div>}
      <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
        {it.inspect && <button className="btn" disabled={busy} onClick={()=>act(it.inspect.label?.includes("组件")?"analyze-component-store":"list-restore-points")}>
          {it.inspect.done ? "重新检查" : it.inspect.label}{it.inspect.admin?"（管理员）":""}{it.inspect.slow?"（慢）":""}
        </button>}
        {(it.actions||[]).filter(a=>a.enabled!==false).map((a,k)=><button key={k} className="btn" disabled={busy}
          style={a.safety==="risky"?{color:"var(--red)"}:a.safety==="caution"?{color:"var(--yellow)"}:undefined}
          title={`${a.cost}\n\n${(a.reasons||[]).map(r=>`• ${r.text}`).join("\n")}`}
          onClick={()=>act(a.id, a.point_id)}>
          {a.label}{a.est_h?`（~${a.est_h}）`:""}{a.admin?" ⚡":""}{a.permanent?" ✕不可逆":""}
        </button>)}
      </div>
    </div>)}
  </div>);
}

// ============================================================ 应用沙箱 tab

function SandboxTab() {
  return <AsyncTab load={()=>window.api.diskSandboxes()} render={d=>{
    const pkgs = d.packages || [];
    return (<div>
      <div className="meta" style={{marginBottom:10}}>
        {d.count} 个包 · 沙箱合计 {d.total_h} —— 商店/MSIX 应用不写真实 AppData，而是写在
        Packages 私有目录里，多数清理工具看不到（Jharu 曾在单个包里发现 86GB 缓存）。
      </div>
      {pkgs.map((p,i)=><div key={i} className="qcard" style={{marginBottom:12,padding:"12px 16px"}}>
        <div style={{display:"flex",gap:10,alignItems:"baseline",flexWrap:"wrap"}}>
          <b style={{fontSize:14}}>{p.display}</b>
          <span className="mono" style={{color:"var(--km-blue,#1783FF)"}}>{p.total_h}</span>
          {p.installed ? <span style={{fontSize:10,color:"var(--dim)"}}>已安装</span>
            : <span style={{fontSize:10,color:"var(--yellow)"}}>已卸载·遗留数据</span>}
          {p.running ? <span style={{fontSize:10,color:"var(--green)"}}>运行中</span> : null}
        </div>
        {p.note && <div style={{fontSize:11,color:"var(--yellow)",marginTop:4}}>{p.note}</div>}
        <div style={{marginTop:8}}>
          <Table head={[["区域",1],["安全"],["体积"],["说明",1]]}
            rows={(p.areas||[]).map((a,k)=><tr key={k}>
              <td className="l"><b>{a.label}</b></td>
              <td><Safe l={a.safety}/></td>
              <td className="mono">{a.size_h}</td>
              <td className="l" style={{fontSize:11,color:"var(--dim)"}}>{a.note}</td>
            </tr>)}/>
        </div>
        {p.areas?.some(a=>a.details?.length) && <div style={{marginTop:6}}>
          <div style={{fontSize:11,color:"var(--dim)",marginBottom:4}}>LocalCache 内的大项：</div>
          <Table head={[["内容",1],["安全"],["体积"],["路径",1]]}
            rows={p.areas.flatMap(a=>a.details||[]).slice(0,10).map((x,k)=><tr key={k}>
              <td className="l"><b>{x.name}</b></td>
              <td><Safe l={x.safety}/></td>
              <td className="mono">{x.size_h}</td>
              <td className="l mono" style={{maxWidth:300,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={x.path}>{x.path}</td>
            </tr>)}/>
        </div>}
      </div>)}
    </div>);
  }}/>;
}

// ============================================================ 自动养护 tab

function AutocareTab() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await window.api.diskAutocare()); } catch { setSt(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const set = useCallback(async (patch) => {
    setBusy(true);
    try { setSt(await window.api.diskAutocareUpdate(patch)); } catch {}
    setBusy(false);
  }, []);
  const runNow = useCallback(async () => {
    if (!window.confirm("立即运行一次定时清理？（仅清理 Safe 且工具自动重建、多日未用的缓存，移入回收站）")) return;
    setBusy(true);
    try {
      const r = await window.api.diskAutocareRun();
      window.alert(r?.ok ? `完成：移入 ${r.moved} 项，释放 ${r.freed_h}` : `失败：${r?.error||"未知"}`);
      await load();
    } catch (e) { window.alert(`失败：${e.message}`); }
    setBusy(false);
  }, [load]);
  if (!st) return <div className="status">…</div>;
  return (<div style={{maxWidth:640}}>
    <div className="qcard" style={{padding:"14px 16px",marginBottom:14}}>
      <label style={{display:"flex",gap:8,alignItems:"center",cursor:"pointer"}}>
        <input type="checkbox" checked={!!st.enabled} disabled={busy}
          onChange={e=>set({enabled: e.target.checked})}
          style={{accentColor:"var(--km-blue,#1783FF)"}}/>
        <b>定时清理</b>
        <span style={{fontSize:11,color:"var(--dim)"}}>仅清理 Safe 且工具自动重建（npm/pip/uv 等）· {st.untouched_days} 天未用 · ≥100MB · 移入回收站可还原</span>
      </label>
      <div style={{display:"flex",gap:16,marginTop:10,flexWrap:"wrap",alignItems:"center"}}>
        <label style={{fontSize:12}}>检查间隔
          <select className="key-input" value={st.interval_hours} disabled={busy}
            onChange={e=>set({interval_hours: +e.target.value})} style={{marginLeft:6,padding:"2px 6px"}}>
            {[1,3,6,12,24].map(h=><option key={h} value={h}>{h} 小时</option>)}
          </select>
        </label>
        <label style={{fontSize:12}}>未用阈值
          <select className="key-input" value={st.untouched_days} disabled={busy}
            onChange={e=>set({untouched_days: +e.target.value})} style={{marginLeft:6,padding:"2px 6px"}}>
            {[1,3,7,14,30].map(d=><option key={d} value={d}>{d} 天</option>)}
          </select>
        </label>
        <button className="btn" disabled={busy} onClick={runNow}>立即运行一次…</button>
      </div>
      <div style={{fontSize:11,color:"var(--dim)",marginTop:8}}>
        上次运行：{st.last_run ? new Date(st.last_run*1000).toLocaleString() : "从未"}
        {st.cleaning ? " · 正在清理…" : ""}
      </div>
    </div>
    <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>运行记录</div>
    {(st.events||[]).length===0 && <div className="status">暂无记录</div>}
    <Table head={[["时间",1],["事件",1]]}
      rows={(st.events||[]).map((e,i)=><tr key={i}>
        <td className="l" style={{fontSize:11}}>{new Date(e.ts*1000).toLocaleString()}</td>
        <td className="l" style={{fontSize:11}}>{e.text}</td>
      </tr>)}/>
  </div>);
}

// ============================================================ 概览仪表盘

const agoStr = (ts) => {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
};

/** 迷你趋势线（同 Jharu Spark）：values 归一化后的折线 */
function Spark({ values, color }) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(20 - ((v - min) / span) * 17).toFixed(1)}`);
  return (
    <svg viewBox="0 0 100 22" preserveAspectRatio="none" style={{ width: "100%", height: 22 }} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

/** 最近六周清理量柱（同 Jharu WeekBars） */
function WeekBars({ values }) {
  const max = Math.max(...(values || [0]), 1);
  return (
    <svg viewBox="0 0 100 22" preserveAspectRatio="none" style={{ width: "100%", height: 22 }} aria-hidden>
      {(values || []).map((v, i) => {
        const h = v > 0 ? Math.max(2, (v / max) * 20) : 1;
        return <rect key={i} x={i * 17 + 1} y={22 - h} width={13} height={h} fill={v > 0 ? "var(--green)" : "var(--track)"} />;
      })}
    </svg>
  );
}

// 概览卡片样式对齐应用 qcard token（背景/边框/圆角/阴影随主题切换）
const ovCard = { minWidth: 0 };
const ovTiles = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 12 };
const ovK = { fontSize: 11, color: "var(--dim)" };
const ovBig = { fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--text)" };

/** 概览仪表盘（1:1 对齐 Jharu Overview.tsx；StarCard 为其产品推广位不移植） */
function OverviewDash({ onNavigate }) {
  const [quick, setQuick] = useState(null);
  const [sources, setSources] = useState(null);
  const [live, setLive] = useState([]);
  const loadQuick = useCallback(() => {
    window.api.diskOverview().then(r => r?.ok && setQuick(r)).catch(() => {});
  }, []);
  useEffect(() => { loadQuick(); }, [loadQuick]);
  useEffect(() => {
    window.api.diskOverviewCleanable().then(r => setSources(r?.ok ? r.sources || [] : [])).catch(() => setSources([]));
  }, []);
  // 实时负载：2s 采样，保留 30 点（页面隐藏时暂停，同 Jharu）。
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      window.api.diskOverviewLive().then(s => { if (alive && s?.ok) setLive(l => [...l.slice(-29), s]); }).catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const sys = quick?.drives?.find(d => d.system) ?? quick?.drives?.[0] ?? null;
  const fixed = (quick?.drives || []).filter(d => !d.removable);
  const firstFull = [...fixed].filter(d => d.days_until_full != null).sort((a, b) => a.days_until_full - b.days_until_full)[0];
  const fullest = firstFull ?? [...fixed].sort((a, b) => (b.used / (b.total || 1)) - (a.used / (a.total || 1)))[0];
  const safeNow = (sources || []).filter(s => ["dev", "ai", "junk"].includes(s.id)).reduce((n, s) => n + (s.safe_bytes || 0), 0);
  const safeItems = (sources || []).filter(s => ["dev", "ai", "junk"].includes(s.id) && (s.safe_bytes || 0) > 0).length;
  const nowLive = live[live.length - 1];
  const maxSource = Math.max(1, ...(sources || []).map(s => (s.safe_bytes || 0) + (s.caution_bytes || 0) + (s.risky_bytes || 0)));
  const map = quick?.system_map || null;
  const boxes = useMemo(() => {
    if (!map) return [];
    const items = [
      ...map.folders.map(f => ({ value: f.bytes, item: f })),
      { value: map.other, item: { name: "其余全部", path: "", bytes: map.other } },
    ];
    return squarify(items, { x: 0, y: 0, w: 100, h: 100 });
  }, [map]);

  const driveTone = d => {
    const used = Math.round((d.used / (d.total || 1)) * 100);
    if (used >= 90 || (d.days_until_full != null && d.days_until_full < 14)) return "bad";
    if (used >= 75) return "warn";
    return "ok";
  };

  return (<div>
    {/* 四个统计 tile */}
    <div style={ovTiles}>
      <div className="qcard" style={ovCard}>
        <span style={ovK}>{sys ? `${sys.mount} 可用` : "系统盘可用"}</span>
        <div style={ovBig}>{sys ? fh(sys.free) : "…"}</div>
        {sys && sys.trend?.length >= 2
          ? <Spark values={sys.trend} color="var(--warn)" />
          : <span style={ovK}>{sys ? `${Math.round((sys.used / (sys.total || 1)) * 100)}% 已用` : ""}</span>}
      </div>
      <div className="qcard" style={ovCard}>
        <span style={ovK}>本应用已释放</span>
        <div style={ovBig}>{quick ? quick.saved_total_h : "…"}</div>
        {quick && (quick.saved_total >= 1_000_000
          ? <WeekBars values={quick.saved_weeks} />
          : <span style={ovK}>移入回收站的内容都会计入（按周显示）</span>)}
      </div>
      <div className="qcard" style={ovCard}>
        <span style={ovK}>现在可安全清理</span>
        <div style={{ ...ovBig, color: "var(--green)" }}>{sources ? fh(safeNow) : "…"}</div>
        <span style={ovK}>{sources
          ? (safeNow > 0 ? `${safeItems} 处，工具会自动重建` : "暂时没有")
          : "正在检查缓存…"}</span>
      </div>
      <div className="qcard" style={ovCard}>
        <span style={ovK}>实时负载</span>
        <div style={{ ...ovBig, display: "flex", gap: 16, fontSize: 18 }}>
          <span><span style={ovK}>CPU </span>{nowLive ? Math.round(nowLive.cpu) : "…"}%</span>
          <span><span style={ovK}>内存 </span>{nowLive ? Math.round((nowLive.memory_used / (nowLive.memory_total || 1)) * 100) : "…"}%</span>
        </div>
        <Spark values={live.map(l => l.cpu)} color="var(--accent)" />
      </div>
    </div>

    {/* 驱动器 + 可清理堆叠 */}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12, marginBottom: 12 }}>
      <div className="qcard" style={ovCard}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ ...ovK, fontWeight: 600 }}>驱动器与满盘预测</span>
          {fullest && <span style={ovK}>最先满：{fullest.mount}</span>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          {fixed.map(d => {
            const pct = Math.round((d.used / (d.total || 1)) * 100);
            return (<div key={d.mount} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minWidth: 92, cursor: "pointer" }}
              title={d.growth_gb_per_day != null ? `增速 ${d.growth_gb_per_day.toFixed(2)}GB/天` : ""}>
              <Ring v={pct} tone={driveTone(d)} label={`${pct}%`} />
              <strong style={{ fontSize: 12 }}>{d.mount}{d.system ? " ⌂" : ""}</strong>
              <span style={ovK}>{fh(d.free)} 可用</span>
              <span style={ovK}>{when(d.days_until_full)}</span>
            </div>);
          })}
          {!quick && <span style={ovK}>读取驱动器…</span>}
        </div>
      </div>
      <div className="qcard" style={ovCard}>
        <div style={{ ...ovK, fontWeight: 600, marginBottom: 8 }}>可清理量（按安全性）</div>
        {!sources && <span style={ovK}>正在检查缓存、回收站与系统文件…</span>}
        {sources && sources.length === 0 && <span style={ovK}>常见位置没有发现可清理项。</span>}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(sources || []).map(s => {
            const total = (s.safe_bytes || 0) + (s.caution_bytes || 0) + (s.risky_bytes || 0);
            return (<button key={s.id} onClick={() => onNavigate(s.tab)} title={`打开「${s.label}」`}
              style={{ all: "unset", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "2px 0" }}>
              <span style={{ fontSize: 12, width: 72, flexShrink: 0 }}>{s.label}</span>
              <span style={{ display: "flex", width: `${Math.max(6, (total / maxSource) * 100)}%`, height: 12, borderRadius: 3, overflow: "hidden" }}>
                {!!s.safe_bytes && <i style={{ flex: s.safe_bytes, background: "var(--green)" }} />}
                {!!s.caution_bytes && <i style={{ flex: s.caution_bytes, background: "var(--yellow)" }} />}
                {!!s.risky_bytes && <i style={{ flex: s.risky_bytes, background: "var(--red)" }} />}
              </span>
              <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--dim)" }}>{fh(total)}</span>
            </button>);
          })}
        </div>
        {sources && sources.length > 0 && (
          <div style={{ display: "flex", gap: 12, marginTop: 8, ...ovK }}>
            <span><i style={{ display: "inline-block", width: 8, height: 8, background: "var(--green)", borderRadius: 2, marginRight: 4 }} />安全</span>
            <span><i style={{ display: "inline-block", width: 8, height: 8, background: "var(--yellow)", borderRadius: 2, marginRight: 4 }} />需注意</span>
            <span><i style={{ display: "inline-block", width: 8, height: 8, background: "var(--red)", borderRadius: 2, marginRight: 4 }} />先核查</span>
          </div>
        )}
      </div>
    </div>

    {/* 系统盘树图 + 最近清理 */}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12, marginBottom: 12 }}>
      <div className="qcard" style={ovCard}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ ...ovK, fontWeight: 600 }}>{map ? `${map.root} 的空间去哪了` : "系统盘空间分布"}</span>
          {map && <span style={ovK}>深度扫描 · {agoStr(map.ts)}</span>}
        </div>
        {map ? (
          <div style={{ position: "relative", width: "100%", height: 190, borderRadius: 8, overflow: "hidden", cursor: "pointer" }}
            onClick={() => onNavigate("deep")} title="打开深度清理">
            {boxes.map((b, i) => (
              <div key={`${b.item.name}-${i}`}
                className={`ov-map-box c${b.item.path ? i % 6 : "x"}`}
                style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}
                title={`${b.item.name}: ${fh(b.value)}`}>
                {b.w > 13 && b.h > 15 && (<>{b.item.name}<b style={{ fontSize: 11 }}>{fh(b.value)}</b></>)}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", padding: "20px 0" }}>
            <span style={ovK}>对 C:\ 跑一次深度清理后，这里会填上空间分布图。</span>
            <button className="btn" onClick={() => onNavigate("deep")}>打开深度清理</button>
          </div>
        )}
      </div>
      <div className="qcard" style={ovCard}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ ...ovK, fontWeight: 600 }}>最近清理</span>
          <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => onNavigate("bin")}>回收站还原</button>
        </div>
        {quick && quick.recent?.length === 0 && <span style={ovK}>还没有记录。移入回收站的内容会列在这里。</span>}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {(quick?.recent || []).map(b => (
            <li key={`${b.time}:${b.label}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {b.label}<span style={ovK}> · {b.source} · {agoStr(b.time)}</span>
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fh(b.bytes)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>

    {/* 快捷动作 */}
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <button className="btn btn-primary" onClick={() => onNavigate("dev")}>
        {safeNow > 0 ? `安全清理 ${fh(safeNow)}` : "打开开发缓存"}
      </button>
      <button className="btn" onClick={() => onNavigate("history")}>看看什么在增长</button>
      <button className="btn" onClick={() => onNavigate("bin")}>回收站</button>
      <button className="btn" onClick={() => onNavigate("deep")}>深度清理</button>
      <button className="btn" onClick={loadQuick} title="刷新概览">↻ 刷新</button>
    </div>
  </div>);
}

// ============================================================ 主页面

export default function DiskPage() {
  const [view, setView] = useState("overview");
  const [drives, setDrives] = useState(null);
  const [devCaches, setDevCaches] = useState(null);
  const [aiTools, setAiTools] = useState(null);
  const [scanPath, setScanPath] = useState("C:\\");
  const [scanResult, setScanResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  // 清理后的强制重载计数（CleanBar onDone 递增）
  const [reload, setReload] = useState({});
  const bumpReload = useCallback(tab => setReload(r => ({ ...r, [tab]: (r[tab]||0)+1 })), []);

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
        <div style={{marginTop:"auto",fontSize:10,color:"var(--faint)",padding:"0 10px"}}>清理进回收站·可还原</div>
      </aside>
      <div style={{flex:1,minWidth:0,overflowY:"auto",padding:"20px 24px"}}>
        {/* 概览仪表盘（Jharu Overview 对齐） */}
        {view==="overview" && <OverviewDash onNavigate={(v)=>{ if(v==="deep"||v==="scan"){ setScanPath("C:\\"); } setView(v); }}/>}

        {/* 开发缓存（可清理） */}
        {view==="dev" && devCaches==="loading" && <div className="status">…</div>}
        {view==="dev" && devCaches!==null && devCaches!=="loading" && <CleanableTab
          load={async () => ({ items: await window.api.diskDevScan() })}
          itemsOf={d => (d.items||[]).flatMap(c => (c.paths||[]).map(p => ({ path: p, size: c.size, label: c.name, safety: c.safety })))}
          source="开发缓存"
          head={[["缓存",1],["安全"],["体积"],["路径",1]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td><Safe l={it.safety}/></td><td className="mono">{fh(it.size)}</td><td className="l mono" style={{maxWidth:340,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.path}</td></>}
/>}

        {/* AI 工具（可清理） */}
        {view==="ai" && aiTools==="loading" && <div className="status">…</div>}
        {view==="ai" && aiTools!==null && aiTools!=="loading" && <CleanableTab
          load={async () => ({ items: await window.api.diskAiTools() })}
          itemsOf={d => (d.items||[]).map(a => ({ path: a.path, size: a.size, label: `${a.tool}·${a.kind}`, safety: a.safety }))}
          source="AI 工具"
          head={[["工具",1],["安全"],["体积"],["路径",1]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td><Safe l={it.safety}/></td><td className="mono">{fh(it.size)}</td><td className="l mono" style={{maxWidth:340,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.path}</td></>}
/>}

        {/* ML 模型（可清理） */}
        {view==="models" && <CleanableTab
          load={()=>window.api.diskScanFull("models")}
          reloadKey={reload.models}
          itemsOf={d => (d.models||[]).flatMap(m => (m.paths||[]).map(p => ({ path: p, size: m.exclusive||m.size, label: `${m.provider}/${m.name}`, safety: "caution" })))}
          source="ML 模型"
          meta={d => `合计 ${fh(d.total||0)} · 未用 ${fh(d.unused||0)}${d.reliable ? "" : "（访问时间不可靠，未用为估计）"}`}
          head={[["模型",1],["体积"],["路径",1]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td className="mono">{fh(it.size)}</td><td className="l mono" style={{maxWidth:340,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.path}</td></>}
          extraWarn="模型删除后需要时可重新下载（体积大）"/>}

        {/* Python（可清理） */}
        {view==="python" && <CleanableTab
          load={()=>window.api.diskScanFull("python")}
          reloadKey={reload.python}
          itemsOf={d => (d.envs||[]).map(e => ({ path: e.path, size: e.size, label: `${e.name}（${e.kind}）`, safety: "caution" }))}
          source="Python"
          head={[["环境",1],["体积"],["路径",1]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td className="mono">{fh(it.size)}</td><td className="l mono" style={{maxWidth:340,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.path}</td></>}
          extraWarn="环境删除后项目需要时可重建/重装"/>}

        {/* 构建产物（可清理） */}
        {view==="projects" && <CleanableTab
          load={()=>window.api.diskProjects("E:\\Proj-Enhanced")}
          reloadKey={reload.projects}
          itemsOf={d => (d.items||[]).map(p => ({ path: p.path, size: p.size, label: `${p.kind}·${p.project}`, safety: "safe" }))}
          source="开发缓存"
          head={[["产物",1],["体积"],["路径",1]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td className="mono">{fh(it.size)}</td><td className="l mono" style={{maxWidth:340,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.path}</td></>}
          extraWarn="构建产物（node_modules/target 等）可由构建工具重建"/>}

        {/* Git worktree（可清理） */}
        {view==="worktrees" && <CleanableTab
          load={()=>window.api.diskWorktrees("E:\\Proj-Enhanced")}
          reloadKey={reload.worktrees}
          itemsOf={d => (d.items||[]).map(w => ({ path: w.path, size: w.size, label: `${w.branch}${w.merged?"（已合并）":""}`, safety: w.merged?"safe":"caution" }))}
          source="Git worktree"
          head={[["分支",1],["安全"],["体积"],["路径",1]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td><Safe l={it.safety}/></td><td className="mono">{fh(it.size)}</td><td className="l mono" style={{maxWidth:320,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.path}</td></>}
          extraWarn="未提交的内容只在该目录里"/>}

        {/* 深度清理（可清理用户/开发类目录） */}
        {view==="deep" && <CleanableTab
          load={()=>window.api.diskDeep(scanPath, 2)}
          reloadKey={reload.deep}
          itemsOf={d => (d.entries||[]).filter(e=>e.is_dir).map(e => ({ path: e.path, size: e.size, label: e.name, safety: (e.kind==="system"||e.kind==="applications")?"risky":"caution" }))}
          source="深度清理"
          head={[["目录",1],["安全"],["体积"]]}
          row={it=><><td className="l mono" style={{maxWidth:280,overflow:"hidden",textOverflow:"ellipsis"}} title={it.path}>{it.label}</td><td><Safe l={it.safety}/></td><td className="mono"><b>{fh(it.size)}</b></td></>}
          extraWarn="系统/应用目录标记为 Risky，删除前务必确认"/>}

        {/* 重复文件（可清理副本） */}
        {view==="dupes" && <CleanableTab          load={()=>window.api.diskDupes([`${scanPath}`], 10000000)}
          reloadKey={reload.dupes}
          itemsOf={d => (d.items||[]).flatMap(g => (g.files||[]).slice(1).map(f => ({ path: f.path, size: Math.floor((g.wasted||0)/Math.max(1,(g.count-1))), label: f.name||g.files?.[0]?.name, safety: "caution" })))}
          source="重复文件"
          head={[["副本文件",1],["体积"]]}
          row={it=><><td className="l mono" style={{maxWidth:320,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.label}</td><td className="mono">{fh(it.size)}</td></>}
          extraWarn="仅清理内容完全一致的副本（SHA-256 相同）"/>}

        {/* 应用沙箱 */}
        {view==="sandboxes" && <SandboxTab/>}

        {/* 浏览器 */}
        {view==="browsers" && <AsyncTab load={()=>window.api.diskScanFull("browsers")} render={d=>
          <div className="quota-grid">{(d.browsers||[]).map((b,i)=><div key={i} className="qcard"><div className="qcard-head"><span className="qname">{b.name}</span></div><div style={{fontSize:12,marginTop:6,color:"var(--dim)"}}>{b.total_h}</div></div>)}</div>}/>}

        {/* 垃圾文件（可清理） */}
        {view==="junk" && <CleanableTab
          load={()=>window.api.diskScanFull("junk")}
          reloadKey={reload.junk}
          itemsOf={d => (d.groups||[]).flatMap(g => (g.items||[]).filter(it=>it.path).map(it => ({ path: it.path, size: it.size, label: it.label||g.title, safety: "safe" })))}
          source="系统文件夹"
          head={[["项目",1],["体积"],["路径",1]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td className="mono">{fh(it.size)}</td><td className="l mono" style={{maxWidth:320,overflow:"hidden",textOverflow:"ellipsis",fontSize:10}} title={it.path}>{it.path}</td></>}/>}

        {/* 桌面（可清理） */}
        {view==="desktop" && <CleanableTab
          load={()=>window.api.diskDesktop()}
          reloadKey={reload.desktop}
          itemsOf={d => (d.items||[]).filter(it=>it.path).map(it => ({ path: it.path, size: it.size, label: it.name, safety: "caution" }))}
          source="桌面"
          head={[["项目",1],["体积"]]}
          row={it=><><td className="l"><b>{it.label}</b></td><td className="mono">{fh(it.size)}</td></>}/>}

        {/* 回收站 */}
        {view==="bin" && <BinTab/>}

        {/* 卸载器 */}
        {view==="apps" && <AppsTab/>}

        {/* 进程 */}
        {view==="processes" && <AsyncTab load={()=>window.api.diskProcesses()} render={d=><Table head={[["进程",1],["PID"],["CPU(s)"],["内存(MB)"],["评级",1]]}
          rows={(Array.isArray(d.items)?d.items:[]).map((p,i)=><tr key={i}><td className="l"><b>{p.ProcessName}</b></td><td className="mono">{p.Id}</td><td className="mono">{p.CPU?Math.round(p.CPU):"—"}</td><td className="mono">{p.MemMB||"—"}</td><td><Safe l={p.safety}/> <span style={{fontSize:10,color:"var(--dim)"}}>{p.reason}</span></td></tr>)}/>}/>} 

        {/* 启动项 */}
        {view==="startup" && <StartupTab/>}

        {/* 系统空间 */}
        {view==="system" && <SystemTab/>}

        {/* 健康 */}
        {view==="health" && <AsyncTab load={()=>window.api.diskScanFull("health")} render={d=><Table head={[["驱动器",1],["总量"],["已用"],["增速"],["预计满盘",1]]}
          rows={(d.forecasts||[]).map((f,i)=><tr key={i}><td className="l mono"><b>{f.path}</b></td><td className="mono">{f.total_gb?.toFixed(0)}GB</td><td className="mono">{f.used_gb?.toFixed(0)}GB</td><td className="mono">{f.growth_gb_per_day?.toFixed(2)}GB/d</td><td className="l">{f.days_to_full!=null?`${f.eta} (~${Math.round(f.days_to_full)}d)`:"—"}</td></tr>)}/>}/>} 

        {/* 空间历史 */}
        {view==="history" && <AsyncTab load={()=>window.api.diskHistory()} render={d=><Table head={[["驱动器",1],["变化",1],["方向"]]}
          rows={(d.changes||[]).map((c,i)=><tr key={i}><td className="l mono">{c.drive}</td><td className="mono">{c.delta_h}</td><td className="l">{c.direction==="grew"?"↑ 增长":"↓ 缩小"}</td></tr>)}/>}/>} 

        {/* 自动养护 */}
        {view==="autocare" && <AutocareTab/>}

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
