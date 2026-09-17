// 应用入口：hash 路由分发窗口页面（#board 看板 / #tools 组件 / #settings 设置 /
// 其余为全量窗口的分析页），并持有 usage-update 广播订阅与主题状态。

import { useEffect, useState } from "react";
import Titlebar, {
  AnalyticsIcon, BoardIcon, GearIcon, ExpandIcon, MaximizeIcon, PinIcon,
  ToolsIcon, useEnvBadge,
} from "./components/Titlebar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Board from "./pages/Board.jsx";
import Tools from "./pages/Tools.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import {
  applyTheme, readThemePreference, resolvedTheme, watchExternalTheme,
} from "./utils.js";

function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "board") return "board";
  if (hash === "tools") return "tools";
  if (hash === "settings") return "settings";
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
    if (window.api.getPinState) window.api.getPinState().then(setPinned);
    return () => {
      off();
      offNavigate();
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const { version, envBadge } = useEnvBadge(lastPayload);
  const isBoard = route === "board";
  const isMain = !isBoard;

  // 主窗口：header 固定、滚动条只作用于内容区（.page-scroll）；看板窗口保持自然高度
  useEffect(() => {
    document.body.classList.toggle("main-window", isMain);
    return () => document.body.classList.remove("main-window");
  }, [isMain]);

  const navigate = (next) => { window.location.hash = `#/${next}`; };
  const triggerRefresh = () => {
    setRefreshing(true);
    window.api.refresh();
  };

  return (
    <>
      <Titlebar title={isBoard ? "AI Usage Monitor" : "Env-Tools"} version={version} envBadge={envBadge}>
        {isBoard ? (
          <button className="btn" title="Open full dashboard" onClick={() => window.api.openFullDashboard()}>
            <ExpandIcon />
          </button>
        ) : (
          <>
            <button
              className={`btn btn-label${route === "dashboard" ? " active" : ""}`}
              title="Usage analytics"
              onClick={() => navigate("dashboard")}
            >
              <AnalyticsIcon /> Analytics
            </button>
            <button
              className={`btn btn-label${route === "tools" ? " active" : ""}`}
              title="Component management"
              onClick={() => navigate("tools")}
            >
              <ToolsIcon /> Tools
            </button>
            <button
              className="btn btn-label"
              title="Open the compact usage board window"
              onClick={() => window.api.openUsageBoard()}
            >
              <BoardIcon /> Board
            </button>
            <button
              className={`btn${route === "settings" ? " active" : ""}`}
              title="Settings"
              onClick={() => navigate(route === "settings" ? "dashboard" : "settings")}
            >
              <GearIcon />
            </button>
          </>
        )}
        <span className="btn-spacer" />
        {isBoard && (
          <button
            className={`btn${pinned ? " active" : ""}`}
            title="Pin on top"
            onClick={async () => setPinned(await window.api.togglePin())}
          >
            <PinIcon />
          </button>
        )}
        {isMain && (
          <button
            className="btn"
            title="Maximize / restore"
            onClick={() => window.api.windowMaximizeToggle()}
          >
            <MaximizeIcon />
          </button>
        )}
        <button className="btn" title="Minimize" onClick={() => window.api.minimize()}>–</button>
        <button className="btn close" title="Close" onClick={() => window.api.close()}>✕</button>
      </Titlebar>

      {isMain ? (
        <div className="page-scroll">
          {route === "tools" && <Tools lastPayload={lastPayload} />}
          {route === "settings" && <SettingsPage lastPayload={lastPayload} />}
          {route === "dashboard" && (
            <Dashboard lastPayload={lastPayload} refreshing={refreshing} onRefresh={triggerRefresh} />
          )}
        </div>
      ) : (
        <Board lastPayload={lastPayload} />
      )}
    </>
  );
}
