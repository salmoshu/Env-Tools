// 标题栏：可拖动，双窗口共用。右侧按钮组由各页面按需传入。

import { useId, useState } from "react";

export function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
    </svg>
  );
}

export function RefreshIcon({ spinning }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
      className={spinning ? "spin" : undefined}
    >
      <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
    </svg>
  );
}

export function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16,9V4h1c0.55,0,1-0.45,1-1s-0.45-1-1-1H7C6.45,2,6,2.45,6,3s0.45,1,1,1h1v5c0,1.66-1.34,3-3,3S4,12.45,4,13s0.45,1,1,1h6v6c0,0.55,0.45,1,1,1s1-0.45,1-1v-6h6c0.55,0,1-0.45,1-1s-0.45-1-1-1C17.34,12,16,10.66,16,9z"/>
    </svg>
  );
}

export function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10L21 11z"/>
    </svg>
  );
}

export function MaximizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
    </svg>
  );
}

export function AnalyticsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z"/>
    </svg>
  );
}

export function BoardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <rect x="3" y="5" width="18" height="14" rx="2" />
    </svg>
  );
}

export function ToolsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>
    </svg>
  );
}

export default function Titlebar({ title, version, envBadge, children }) {
  return (
    <div className="titlebar">
      <img className="logo" src="assets/logo.svg" alt="" />
      <span className="title">{title}</span>
      <span className="title-version">{version ? `v${version}` : ""}</span>
      <span className={`env-badge${envBadge ? "" : " hidden"}`}>{envBadge || ""}</span>
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
