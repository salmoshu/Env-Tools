// 应用入口：hash 路由分发窗口页面（#board 看板 / #tools 组件 / #settings 设置 /
// 其余为全量窗口的分析页）。主窗口左侧边栏导航：Analytics / Tools；悬浮看板
// 入口为 header 图标按钮（设置齿轮左侧），header 右侧其余为窗口按钮。

import { useEffect, useRef, useState } from "react";
import Titlebar, {
  AnalyticsIcon, BoardIcon, GearIcon, ExpandIcon, MaximizeIcon, RestoreIcon, PinIcon,
  ToolsIcon, useEnvBadge,
} from "./components/Titlebar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Board from "./pages/Board.jsx";
import Tools from "./pages/Tools.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import { t, useLang } from "./i18n.js";
import { showToast, ToastStack } from "./toast.jsx";
import {
  activateOnKeys, applyTheme, readThemePreference, resolvedTheme, watchExternalTheme,
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
  const [maximized, setMaximized] = useState(false);
  const [theme, setTheme] = useState(readThemePreference());
  // 手动刷新后 Codex 处于"沿用旧数据"窗口时的一次性提醒（顶部框，自动消失）
  const wasRefreshing = useRef(false);
  // 刷新看门狗：usage-update 广播未到达（后端超时/链路异常）时按钮会被
  // disabled 卡死——65s 强制复位（后端取数超时 60s，广播应在此之前到达），
  // 避免"点了没反应、只能等它自己恢复"的观感
  const refreshWatchdog = useRef(0);
  // 订阅语言切换：t() 的输出随 useLang 状态变化整树重渲染
  useLang();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => watchExternalTheme(setTheme), []);

  // 系统明暗切换即时跟随：preference 为 system 时媒体查询变化直接重解析主题。
  // 走 setTheme("system") 不行——状态值未变 React 不重渲染，applyTheme 不会
  // 重新执行（v0.7.31 修复：此前表现为切深浅色无反应，需点一下"系统"）
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    if (wasRefreshing.current && !refreshing && lastPayload) {
      const codexStale = (((lastPayload.data || {}).accounts) || [])
        .some((a) => a.provider === "OpenAI Codex" && a.stale);
      if (codexStale) showToast(t("dash.quotaStaleToast"), "info");
    }
    wasRefreshing.current = refreshing;
  }, [refreshing, lastPayload]);

  useEffect(() => {
    const onAccountSync = (event) => {
      const sync = event.detail && event.detail.sync;
      if (!sync) return;
      const failed = Array.isArray(sync.failed) ? sync.failed : [];
      const succeeded = Array.isArray(sync.succeeded) ? sync.succeeded : [];
      if (failed.length) {
        showToast(t("settings.accountSyncPartial")
          .replace("{n}", String(failed.length))
          .replace("{scopes}", failed.map((item) => item.scope).join(", ")), "error", 6000);
      } else {
        showToast(t("settings.accountSyncSuccess").replace("{n}", String(succeeded.length)), "ok");
      }
    };
    window.addEventListener("agent-account-sync", onAccountSync);
    return () => window.removeEventListener("agent-account-sync", onAccountSync);
  }, []);

  useEffect(() => {
    const off = window.api.onUsageUpdate((payload) => {
      clearTimeout(refreshWatchdog.current);
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
    const offMaximized = window.api.onMaximizedChanged(setMaximized);
    window.api.isMaximized().then(setMaximized);
    return () => {
      off();
      offNavigate();
      offMaximized();
      clearTimeout(refreshWatchdog.current);
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
    clearTimeout(refreshWatchdog.current);
    refreshWatchdog.current = setTimeout(() => setRefreshing(false), 65000);
    try {
      window.api.refresh();
    } catch {
      clearTimeout(refreshWatchdog.current);
      setRefreshing(false);
    }
  };

  return (
    <div className={isBoard ? "board-frame" : "app-frame"}>
      <ToastStack />
      <Titlebar title={isBoard ? "AI Usage Monitor" : "Env-Tools"} version={version} envBadge={envBadge}>
        {isBoard ? (
          <button type="button" className="btn" title={t("tip.expand")} onClick={() => window.api.openFullDashboard()}>
            <ExpandIcon />
          </button>
        ) : null}
        <span className="btn-spacer" />
        {isBoard && (
          <button
            type="button"
            className={`btn${pinned ? " active" : ""}`}
            title={t("tip.pin")}
            onClick={async () => setPinned(await window.api.togglePin())}
          >
            <PinIcon />
          </button>
        )}
        {isMain && (
          <button
            type="button"
            className="btn"
            title={t("tip.board")}
            onClick={() => window.api.openUsageBoard()}
          >
            <BoardIcon />
          </button>
        )}
        {isMain && (
          <button
            type="button"
            className={`btn${isSettings ? " active" : ""}`}
            title={t("tip.settings")}
            onClick={() => navigate(isSettings ? "dashboard" : "settings")}
          >
            <GearIcon />
          </button>
        )}
        <button type="button" className="btn" title={t("tip.minimize")} onClick={() => window.api.minimize()}>–</button>
        {isMain && (
          <button
            type="button"
            className="btn"
            title={maximized ? t("tip.restore") : t("tip.maximize")}
            onClick={async () => setMaximized(await window.api.windowMaximizeToggle())}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
        )}
        <button type="button" className="btn close" title={t("tip.close")} onClick={() => window.api.close()}>✕</button>
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
              role="button"
              tabIndex={0}
              onClick={() => navigate("dashboard")}
              onKeyDown={activateOnKeys(() => navigate("dashboard"))}
              title={t("tip.analytics")}
            >
              <span className="nav-icon"><AnalyticsIcon /></span> {t("nav.analytics")}
            </div>
            <div
              className={`side-item nav${route === "tools" ? " active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => navigate("tools")}
              onKeyDown={activateOnKeys(() => navigate("tools"))}
              title={t("tip.tools")}
            >
              <span className="nav-icon"><ToolsIcon /></span> {t("nav.tools")}
            </div>
          </nav>
          {/* 两页常驻、只切显示：此前每次切页都卸载重建 Dashboard，
              实测切回时有 85–97ms 长任务和帧尖峰（切页卡顿主因） */}
          <div className="page-scroll" style={{ display: route === "tools" ? undefined : "none" }}>
            <Tools lastPayload={lastPayload} />
          </div>
          <div className="dashboard-pane" style={{ display: route === "dashboard" ? undefined : "none" }}>
            <Dashboard
              lastPayload={lastPayload}
              refreshing={refreshing}
              onRefresh={triggerRefresh}
            />
          </div>
        </div>
      )}
    </div>
  );
}
