import { type ReactNode, useEffect, useState } from "react";
import Overview from "./views/Overview";
import DevClean from "./views/DevClean";
import DeepClean from "./views/DeepClean";
import Browsers from "./views/Browsers";
import Uninstaller from "./views/Uninstaller";
import DriveHealth from "./views/DriveHealth";
import Junk from "./views/Junk";
import Models from "./views/Models";
import Python from "./views/Python";
import Desktop from "./views/Desktop";
import Worktrees from "./views/Worktrees";
import RecycleBin from "./views/RecycleBin";
import Projects from "./views/Projects";
import SystemSpace from "./views/SystemSpace";
import Duplicates from "./views/Duplicates";
import History from "./views/History";
import Sandboxes from "./views/Sandboxes";
import AiTools from "./views/AiTools";
import Speed from "./views/Speed";
import Startup from "./views/Startup";
import GadgetSettings from "./components/GadgetSettings";
import { formatBytes, isWindows } from "./format";
import { dt, useLang } from "./i18n";

type View =
  | "overview" | "dev" | "models" | "python" | "projects" | "worktrees" | "ai"
  | "deep" | "dupes" | "sandboxes" | "system" | "junk" | "desktop" | "browsers"
  | "bin" | "uninstall" | "speed" | "startup" | "health" | "history" | "about";

type NavItem = { id: View; label: string; icon: string; sub: string };

const NAV: { group: string; items: NavItem[] }[] = [
  { group: "", items: [{ id: "overview", label: "Overview", icon: "◎", sub: "Drives, savings, forecast" }] },
  { group: "Developer", items: [
    { id: "dev", label: "Dev clean", icon: "⌘", sub: "ML and dev caches" },
    { id: "models", label: "ML models", icon: "◈", sub: "Per-model, used or not" },
    { id: "python", label: "Python", icon: "◐", sub: "Envs and duplicates" },
    { id: "projects", label: "Build folders", icon: "▥", sub: "node_modules, target, venvs" },
    { id: "worktrees", label: "Git worktrees", icon: "⑂", sub: "Merged spare checkouts" },
    { id: "ai", label: "AI tools", icon: "✦", sub: "Agent caches and history" },
  ] },
  { group: "Disk", items: [
    { id: "deep", label: "Deep clean", icon: "◉", sub: "Full-disk analysis" },
    { id: "dupes", label: "Duplicates", icon: "⧉", sub: "Same file or model twice" },
    { id: "sandboxes", label: "App sandboxes", icon: "▣", sub: isWindows ? "Hidden Store-app data" : "Containers of removed apps" },
    { id: "system", label: "System space", icon: "▦", sub: isWindows ? "Hibernation, restore points, Docker" : "Snapshots, sleep image, Docker" },
    { id: "junk", label: "Junk files", icon: "▤", sub: "Installers, backups, logs" },
    { id: "desktop", label: "Desktop", icon: "▢", sub: "Screenshots and clutter" },
    { id: "browsers", label: "Browsers", icon: "◍", sub: "Web caches" },
  ] },
  { group: "Manage", items: [
    { id: "bin", label: isWindows ? "Recycle Bin" : "Trash", icon: "♻", sub: "Restore or empty" },
    { id: "uninstall", label: "Uninstaller", icon: "✕", sub: "Apps and leftovers" },
    { id: "speed", label: "Speed", icon: "↯", sub: "Live load, task killer" },
    { id: "startup", label: "Startup apps", icon: "⏻", sub: "What starts at sign-in" },
  ] },
  { group: "Insight", items: [
    { id: "health", label: "Drive health", icon: "♥", sub: "Capacity and SMART" },
    { id: "history", label: "Space history", icon: "◔", sub: "What grew, forecast, alerts" },
    { id: "about", label: "Settings", icon: "◈", sub: "Floating gadget" },
  ] },
];

const KEPT: View[] = ["worktrees", "projects", "system", "dupes", "sandboxes", "ai", "speed"];

function About() {
  useLang();
  return <>
    <div className="view-head">
      <div><h2 className="view-title">{dt("Disk settings")}</h2><p className="view-sub">{dt("Storage monitor and safe cleaning controls")}</p></div>
    </div>
    <GadgetSettings />
    <p className="footnote left">{dt("Application updates remain available in Env-Tools Settings.")}</p>
  </>;
}

export default function DiskApp() {
  useLang();
  const [view, setView] = useState<View>("overview");
  const [recovered, setRecovered] = useState(0);
  const [opened, setOpened] = useState<Set<View>>(() => new Set());

  useEffect(() => {
    if (KEPT.includes(view)) setOpened(current => current.has(view) ? current : new Set(current).add(view));
  }, [view]);

  const kept = (id: View, element: ReactNode) => (opened.has(id) || view === id) && (
    <div style={{ display: view === id ? undefined : "none" }}>{element}</div>
  );
  const addRecovered = (bytes: number) => setRecovered(current => current + bytes);

  return <div className="jharu-root shell">
    <aside className="sidebar">
      <nav className="nav">
        {NAV.map(group => <div key={group.group} className="nav-group">
          {group.group && <span className="nav-group-title">{dt(group.group)}</span>}
          {group.items.map(item => <button key={item.id} className={`nav-item ${view === item.id ? "is-active" : ""}`} onClick={() => setView(item.id)}>
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-text"><span className="nav-label">{dt(item.label)}</span><span className="nav-sub">{dt(item.sub)}</span></span>
          </button>)}
        </div>)}
      </nav>
      <div className="sidebar-foot">
        {recovered > 0 && <div className="recovered-tile"><span className="metric-label">{dt("Recovered this session")}</span><span className="recovered-value">{formatBytes(recovered)}</span></div>}
        <p className="footnote left">{dt("Everything goes to the Recycle Bin or Trash unless an action explicitly says otherwise.")}</p>
      </div>
    </aside>
    <div className="main-col">
      <div className="content-scroll"><main className="content">
        {view === "overview" && <Overview onNavigate={next => setView(next as View)} />}
        {view === "dev" && <DevClean onRecovered={addRecovered} />}
        {view === "models" && <Models onRecovered={addRecovered} />}
        {view === "python" && <Python onRecovered={addRecovered} />}
        {kept("projects", <Projects onRecovered={addRecovered} />)}
        {kept("worktrees", <Worktrees onRecovered={addRecovered} />)}
        {kept("ai", <AiTools onRecovered={addRecovered} onOpen={next => setView(next as View)} />)}
        {view === "deep" && <DeepClean onRecovered={addRecovered} />}
        {kept("dupes", <Duplicates onRecovered={addRecovered} />)}
        {kept("sandboxes", <Sandboxes onRecovered={addRecovered} />)}
        {kept("system", <SystemSpace onRecovered={addRecovered} />)}
        {view === "junk" && <Junk onRecovered={addRecovered} />}
        {view === "desktop" && <Desktop onRecovered={addRecovered} />}
        {view === "browsers" && <Browsers onRecovered={addRecovered} />}
        {view === "bin" && <RecycleBin onRecovered={addRecovered} />}
        {view === "uninstall" && <Uninstaller onRecovered={addRecovered} />}
        {kept("speed", <Speed />)}
        {view === "startup" && <Startup />}
        {view === "health" && <DriveHealth />}
        {view === "history" && <History onRecovered={addRecovered} />}
        {view === "about" && <About />}
      </main></div>
    </div>
  </div>;
}
