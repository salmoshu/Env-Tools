// Kimi 网页会话授权：会员等级与月总额度来自 kimi.com 网页接口，CLI 登录
// 不包含这些信息。用户在浏览器复制 refresh_token，后端验证后写入本机凭证
// （默认账号写 Windows 侧 ~/.kimi-code/credentials/kimi-web.json）。
import { useState } from "react";
import { t } from "../i18n.js";
import { showToast } from "../toast.jsx";
import Dialog from "./Dialog.jsx";

// 错误码 → 引导文案：过期类要求重新复制 token，网络类只需重试
function errorHint(code) {
  if (code === "kimi_web_network") return t("kimiAuth.networkHint");
  if (code === "kimi_web_session_expired" || code === "kimi_web_missing_token") {
    return t("kimiAuth.expiredHint");
  }
  return "";
}

export default function KimiWebAuth({ account, onClose, onSaved }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");

  const openSite = async () => {
    try {
      await window.api?.openExternal?.("https://www.kimi.com");
    } catch {}
  };

  const submit = async (event) => {
    event?.preventDefault?.();
    const value = token.trim();
    if (!value) {
      setErrorCode("empty");
      setError(t("kimiAuth.empty"));
      return;
    }
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      const result = await window.api?.saveKimiWebCredential?.({
        account_id: (account && account.account_id) || "default",
        refresh_token: value,
      });
      if (result && result.ok) {
        showToast(t("kimiAuth.saved"), "ok");
        onSaved?.(result.data || {});
        onClose?.();
        return;
      }
      setErrorCode((result && result.code) || "unknown");
      setError((result && result.error) || t("state.unknownError"));
    } catch (err) {
      setErrorCode("kimi_web_network");
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("kimiAuth.title")}
      description={t("dash.kimiWebReauthHint")}
      onClose={onClose}
      actions={<>
        <button type="button" className="ghost" onClick={onClose}>{t("notice.close")}</button>
        <button type="button" disabled={busy} aria-busy={busy} onClick={submit}>
          {busy ? t("kimiAuth.verifying") : t("kimiAuth.save")}
        </button>
      </>}
    >
      <div className="kimi-auth">
        <div className="kimi-auth-step">
          <span className="kimi-auth-num">1</span>
          <div>
            <div>{t("kimiAuth.step1")}</div>
            <button type="button" className="kimi-auth-link" onClick={openSite}>
              {t("kimiAuth.openSite")}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 4h6v6" />
                <path d="M20 4 10 14" />
                <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
              </svg>
            </button>
          </div>
        </div>
        <div className="kimi-auth-step">
          <span className="kimi-auth-num">2</span>
          <div>{t("kimiAuth.step2")}</div>
        </div>
        <div className="kimi-auth-step">
          <span className="kimi-auth-num">3</span>
          <div>{t("kimiAuth.step3")}</div>
        </div>
        <form onSubmit={submit}>
          <textarea
            className="kimi-auth-input"
            rows={3}
            spellCheck={false}
            data-autofocus
            tabIndex="0"
            disabled={busy}
            value={token}
            placeholder={t("kimiAuth.placeholder")}
            onChange={(event) => setToken(event.target.value)}
          />
        </form>
        {error ? (
          <div className="kimi-auth-error" role="alert">
            <div>{error}</div>
            {errorHint(errorCode) ? <div className="kimi-auth-error-hint">{errorHint(errorCode)}</div> : null}
          </div>
        ) : null}
        <div className="kimi-auth-privacy">{t("kimiAuth.privacy")}</div>
      </div>
    </Dialog>
  );
}
