// 标题栏：可拖动，双窗口共用。右侧按钮组由各页面按需传入。
// v0.7.33 品牌重塑：全部图标改为 1.5px 细线、圆角端点、currentColor 着色；
// 应用标记换成「三根用量柱 + 品牌蓝点」的几何符号（logo 蓝点在 UI 的复现）。

export function BrandMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="13" width="3.6" height="8" rx="1.8" fill="currentColor" opacity="0.5" />
      <rect x="8.5" y="9" width="3.6" height="12" rx="1.8" fill="currentColor" opacity="0.78" />
      <rect x="14.5" y="5" width="3.6" height="16" rx="1.8" fill="currentColor" />
      <circle cx="20.6" cy="4.2" r="2" fill="var(--accent)" />
    </svg>
  );
}

function LineIcon({ size = 15, children }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function GearIcon() {
  return (
    <LineIcon>
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.64.88 1.04 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </LineIcon>
  );
}

export function RefreshIcon({ spinning }) {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      className={spinning ? "spin" : undefined}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function PinIcon() {
  return (
    <LineIcon>
      <path d="M12 17v5" />
      <path d="M9 10.76V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V16H5v-.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z" />
    </LineIcon>
  );
}

export function ExpandIcon() {
  return (
    <LineIcon>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </LineIcon>
  );
}

export function MaximizeIcon() {
  return (
    <LineIcon size={14}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </LineIcon>
  );
}

// 还原（已最大化）：前窗 + 后窗的错层双框，与最大化单框区分
export function RestoreIcon() {
  return (
    <LineIcon size={14}>
      <rect x="7" y="9" width="13" height="13" rx="2" />
      <path d="M4 15V5.5A1.5 1.5 0 0 1 5.5 4H15" />
    </LineIcon>
  );
}

export function AnalyticsIcon() {
  return (
    <LineIcon>
      <path d="M3 3v18h18" />
      <path d="M8 17v-5" />
      <path d="M13 17V8" />
      <path d="M18 17V5" />
    </LineIcon>
  );
}

// 悬浮看板：主窗口线框 + 右下角骑跨边框的实心小窗（画中画浮窗），
// 小窗压在边框角上而不是缩在大框内，读作「浮在上层的迷你窗口」
export function BoardIcon() {
  return (
    <LineIcon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" fill="currentColor" stroke="none" />
    </LineIcon>
  );
}

export function ToolsIcon() {
  return (
    <LineIcon>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </LineIcon>
  );
}

export default function Titlebar({ title, version, envBadge, children }) {
  return (
    <div className="titlebar">
      <span className="logo"><BrandMark size={18} /></span>
      <span className="title">{title}</span>
      {version ? <span className="title-version">v{version}</span> : null}
      {envBadge ? <span className="env-badge">{envBadge}</span> : null}
      {children}
    </div>
  );
}

export function useEnvBadge(lastPayload) {
  const data = lastPayload && lastPayload.data;
  if (!data) return { version: "", envBadge: "" };
  const switched = data.environment && data.native_environment
    && data.environment !== data.native_environment;
  return {
    version: data.monitor_version || "",
    envBadge: switched ? data.environment : "",
  };
}
