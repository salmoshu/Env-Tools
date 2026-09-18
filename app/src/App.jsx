// 应用入口：hash 路由分发窗口页面（#board 看板 / #tools 组件 / #settings 设置 /
// 其余为全量窗口的分析页）。v0.7.1 起主窗口采用左侧边栏导航：Analytics /
// Tools / Board 住侧边栏，header 右侧只留设置与窗口按钮。

import { useEffect, useState } from "react";
import Titlebar, {
  AnalyticsIcon, BoardIcon, GearIcon, ExpandIcon, MaximizeIcon, PinIcon,
  ToolsIcon, useEnvBadge,
} from "./components/Titlebar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Board from "./pages/Board.jsx";
import Tools from "./pages/Tools.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import { t, useLang } from "./i18n.js";
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
  // 订阅语言切换：t() 的输出随 useLang 状态变化整树重渲染
  useLang();

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
  const isSettings = route === "settings";

  const navigate = (next) => { window.location.hash = `#/${next}`; };
  const triggerRefresh = () => {
    setRefreshing(true);
    window.api.refresh();
  };

  return (
    <div className={isBoard ? "board-frame" : "app-frame"}>
      <Titlebar title={isBoard ? "AI Usage Monitor" : "Env-Tools"} version={version} envBadge={envBadge}>
        {isBoard ? (
          <button className="btn" title={t("tip.expand")} onClick={() => window.api.openFullDashboard()}>
            <ExpandIcon />
          </button>
        ) : null}
        <span className="btn-spacer" />
        {isBoard && (
          <button
            className={`btn${pinned ? " active" : ""}`}
            title={t("tip.pin")}
            onClick={async () => setPinned(await window.api.togglePin())}
          >
            <PinIcon />
          </button>
        )}
        {isMain && (
          <button
            className={`btn${isSettings ? " active" : ""}`}
            title={t("tip.settings")}
            onClick={() => navigate(isSettings ? "dashboard" : "settings")}
          >
            <GearIcon />
          </button>
        )}
        <button className="btn" title={t("tip.minimize")} onClick={() => window.api.minimize()}>–</button>
        {isMain && (
          <button
            className="btn"
            title={t("tip.maximize")}
            onClick={() => window.api.windowMaximizeToggle()}
          >
            <MaximizeIcon />
          </button>
        )}
        <button className="btn close" title="Close" onClick={() => window.api.close()}>✕</button>
      </Titlebar>

      {isBoard ? (
        <Board lastPayload={lastPayload} />
      ) : isSettings ? (
        <SettingsPage lastPayload={lastPayload} refreshing={refreshing} onRefresh={triggerRefresh} />
      ) : (
        <div className="app-body">
          <nav className="app-sidebar">
            <div
              className={`side-item nav${route === "dashboard" ? " active" : ""}`}
              onClick={() => navigate("dashboard")}
              title={t("tip.analytics")}
            >
              <AnalyticsIcon /> {t("nav.analytics")}
            </div>
            <div
              className={`side-item nav${route === "tools" ? " active" : ""}`}
              onClick={() => navigate("tools")}
              title={t("tip.tools")}
            >
              <ToolsIcon /> {t("nav.tools")}
            </div>
            <div
              className="side-item nav"
              onClick={() => window.api.openUsageBoard()}
              title={t("tip.board")}
            >
              <BoardIcon /> {t("nav.board")}
            </div>
          </nav>
          {route === "tools" && (
            <div className="page-scroll">
              <Tools lastPayload={lastPayload} />
            </div>
          )}
          {route === "dashboard" && (
            <Dashboard
              lastPayload={lastPayload}
              refreshing={refreshing}
              onRefresh={triggerRefresh}
            />
          )}
        </div>
      )}
    </div>
  );
}
