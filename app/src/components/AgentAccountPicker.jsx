import { useEffect, useMemo, useRef, useState } from "react";

export function agentAccountId(account, index = 0) {
  const id = account && (account.account_id || account.id);
  return String(id || (index === 0 ? "default" : `account-${index}`));
}

export function agentAccountLabel(account) {
  return String(
    (account && (account.account_label || account.label || account.account_id || account.id)) || "Default",
  );
}

function windowPercent(window) {
  if (!window || window.used_percent == null || !Number.isFinite(Number(window.used_percent))) return "—";
  return `${Math.max(0, Math.min(100, Number(window.used_percent))).toFixed(1)}%`;
}

function usageItems(account) {
  const windows = Array.isArray(account && account.windows) ? account.windows : [];
  const rank = (window) => {
    const label = String(window && window.label || "").toLowerCase();
    if (label.includes("5h")) return 0;
    if (label.includes("7d")) return 1;
    return 2;
  };
  return windows
    .map((window, index) => ({ window, index }))
    .sort((a, b) => rank(a.window) - rank(b.window) || a.index - b.index)
    .slice(0, 2)
    .map(({ window }) => ({
      label: String(window.label || "usage").replace(/\s+window$/i, ""),
      percent: windowPercent(window),
    }));
}

export default function AgentAccountPicker({ accounts, value, onChange, disabled = false, error = "", errorLabel = "Switch failed", hint = "Account", emptyUsage = "—" }) {
  const options = useMemo(() => (accounts || []).map((account, index) => ({
    account,
    id: agentAccountId(account, index),
    label: agentAccountLabel(account),
    usage: usageItems(account),
  })), [accounts]);
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const optionRefs = useRef([]);
  const selectedId = value || (options[0] && options[0].id) || "default";
  const selected = options.find((option) => option.id === selectedId) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const selectedIndex = Math.max(0, options.findIndex((option) => option.id === selectedId));
    optionRefs.current[selectedIndex]?.focus();
    const closeOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open, selectedId, options]);

  if (options.length < 2) return null;

  const choose = (id) => {
    setOpen(false);
    onChange(id);
    buttonRef.current?.focus();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    const items = optionRefs.current.filter(Boolean);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
      : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const toggleOpen = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const menuHeight = Math.min(248, options.length * 34 + 12);
      setOpenUp(rect.bottom + menuHeight > window.innerHeight && rect.top > menuHeight);
    }
    setOpen((value) => !value);
  };

  return (
    <div className="agent-account-picker" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={buttonRef}
        className="codex-account-select agent-account-trigger"
        aria-label={hint}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={hint}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <span className="agent-account-trigger-label">{selected ? selected.label : "Default"}</span>
        <span className={`agent-account-chevron${open ? " open" : ""}`} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className={`agent-account-menu${openUp ? " up" : ""}`} role="listbox" aria-label={hint}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.id === selectedId}
              key={option.id}
              ref={(element) => { optionRefs.current[index] = element; }}
              className={`agent-account-option${option.id === selectedId ? " selected" : ""}`}
              onClick={() => choose(option.id)}
            >
              <span className="agent-account-option-label">{option.label}</span>
              <span className="agent-account-option-usage">
                {option.usage.length
                  ? option.usage.map((item) => `${item.label} ${item.percent}`).join(" · ")
                  : emptyUsage}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <span className="stale-tag" title={error}>{errorLabel}</span> : null}
    </div>
  );
}
