// 升级确认浮层（看板小窗与主窗口仪表盘共用）：仅负责确认动作。
// v0.7.12 起确认后立即关闭——升级过程不阻塞界面：卡片头部显示
// "升级中…"动态提醒，完整日志流到组件管理的终端面板。
// payload 需含 data.versions（用于"全部升级"按钮的过期清单）。

import { useEffect, useRef, useState } from "react";
import { isNewerVersion } from "../utils.js";
import { t } from "../i18n.js";

export default function UpgradeOverlay({ provider, payload, onClose, onStart }) {
  const versions = (payload.data && payload.data.versions) || {};
  const info = versions[provider] || {};
  const outdated = Object.keys(versions).filter((key) => {
    const item = versions[key] || {};
    return item.current && item.latest && isNewerVersion(item.latest, item.current);
  });
  const startedRef = useRef(false);

  const begin = (targets) => {
    if (startedRef.current) return;
    startedRef.current = true;
    onStart(targets, provider);
    onClose();
  };

  return (
    <div className="overlay">
      <div className="dialog">
        <div className="dialog-title">{provider}</div>
        <div className="dialog-ver">v{info.current} → {info.latest}</div>
        <div className="dialog-btns">
          <button type="button" onClick={() => begin([provider])}>{t("upgrade.action")} {provider}</button>
          {outdated.length > 1 && (
            <button type="button" onClick={() => begin(outdated)}>{t("upgrade.all")} ({outdated.length})</button>
          )}
          <button type="button" className="ghost" onClick={onClose}>{t("upgrade.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
