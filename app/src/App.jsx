// 应用入口：hash 路由分发窗口页面（#board 看板 / #tools 组件 / 其余为全量窗口
// 的分析页），并持有 usage-update 广播订阅与主题状态。

import { useEffect, useState } from "react";
import Titlebar, { GearIcon, ExpandIcon, PinIcon, RefreshIcon, ToolsIcon, useEnvBadge } from "./components/Titlebar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Board from "./pages/Board.jsx";
import Tools from "./pages/Tools.jsx";
import {
  applyTheme, readThemePreference, resolvedTheme, watchExternalTheme,
} from "./utils.js";

function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "board") return "board";
  if (hash === "tools") return "tools";
  return "dashboard";
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);
  const [lastPayload, setLastPayload] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [theme, setTheme] = useState(readThemePreference());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => watchExternalTheme(setTheme), []);

  useEffect(() => {
    const off = window.api.onUsageUpdate((payload) => {
      setLastPayload(payload);
      setRefreshing(false);
    });
    const offNavigate = window.api.onNavigate((next) => {
      if (next !== currentRoute()) {
        window.location.hash = `#/${next}`;
      }
    });
    const onHash = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    window.api.getPinState().then(setPinned);
    return () => {
      off();
      offNavigate();
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const { version, envBadge } = useEnvBadge(lastPayload);
  const isBoard = route === "board";

  return (
    <>
      <Titlebar title={isBoard ? "AI Usage Monitor" : "Env-Tools"} version={version} envBadge={envBadge}>
        {isBoard ? (
          <>
            <button className="btn" title="Open full dashboard" onClick={() => window.api.openFullDashboard()}>
              <ExpandIcon />
            </button>
            <button className="btn" title="Settings" onClick={() => window.api.openBoardSettings()}>
              <GearIcon />
            </button>
          </>
        ) : (
          <>
            <button
              className={`btn btn-label${route === "dashboard" ? " active" : ""}`}
              title="Usage analytics"
              onClick={() => { window.location.hash = "#/dashboard"; }}
            >
              Analytics
            </button>
            <button
              className={`btn btn-label${route === "tools" ? " active" : ""}`}
              title="Component management"
              onClick={() => { window.location.hash = "#/tools"; }}
            >
              <ToolsIcon /> Tools
            </button>
            <button className="btn btn-label" title="Open the compact usage board window" onClick={() => window.api.openUsageBoard()}>
              Board
            </button>
            <button className="btn" title="Settings" onClick={() => window.api.openBoardSettings()}>
              <GearIcon />
            </button>
            <button
              className="btn" title="Refresh" onClick={() => { setRefreshing(true); window.api.refresh(); }}
            >
              <RefreshIcon spinning={refreshing} />
            </button>
          </>
        )}
        <button
          className={`btn${pinned ? " active" : ""}`}
          title="Pin on top"
          onClick={async () => setPinned(await window.api.togglePin())}
        >
          <PinIcon />
        </button>
        <button className="btn" title="Minimize" onClick={() => window.api.minimize()}>–</button>
        <button className="btn close" title="Close" onClick={() => window.api.close()}>✕</button>
      </Titlebar>

      {route === "board" && <Board lastPayload={lastPayload} />}
      {route === "tools" && <Tools lastPayload={lastPayload} />}
      {route === "dashboard" && <Dashboard lastPayload={lastPayload} />}
    </>
  );
}
