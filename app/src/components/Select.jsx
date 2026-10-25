// Kimi 品牌规范的自定义下拉框（docs：Brand/12-下拉框与弹出菜单.md）。
// 触发器沿用原生 select 的形态（30–32px 高、1px 细边、8px 圆角 + 16px 灰色
// caret）；点击展开的浮层按规范实现：容器 12px 圆角 + 4px 内边距 + 0.5px
// 细边 + 弥散阴影，菜单项 36px 高 + 10px 圆角，hover Fills-F1，选中项唯一
// 彩色元素为品牌蓝对勾——替换浏览器默认菜单，观感与 AgentAccountPicker 一致。
import { useEffect, useLayoutEffect, useRef, useState } from "react";

function Chevron() {
  return (
    <svg className="kselect-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="kselect-check" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Select({ value, onChange, options, className = "", ariaLabel, align = "left" }) {
  const entries = (options || []).map((option) =>
    Array.isArray(option) ? { value: option[0], label: option[1] } : option);
  const selected = entries.find((entry) => entry.value === value) || entries[0];
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    const menuHeight = Math.min(280, entries.length * 36 + 10);
    setOpenUp(Boolean(rect && rect.bottom + menuHeight > window.innerHeight && rect.top > menuHeight));
    setHighlight(Math.max(0, entries.findIndex((entry) => entry.value === selected?.value)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-highlight="1"]')?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const choose = (entry) => {
    setOpen(false);
    buttonRef.current?.focus();
    if (entry && entry.value !== value) onChange?.(entry.value);
  };

  const onKeyDown = (event) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((prev) => {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = prev + delta;
        return next < 0 ? entries.length - 1 : next >= entries.length ? 0 : next;
      });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlight(event.key === "Home" ? 0 : entries.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(entries[highlight]);
    }
  };

  return (
    <div className={`kselect${open ? " open" : ""}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={buttonRef}
        className={`kselect-trigger${className ? ` ${className}` : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="kselect-label">{selected ? selected.label : ""}</span>
        <Chevron />
      </button>
      {open ? (
        <div className={`kselect-menu${openUp ? " up" : ""}${align === "right" ? " right" : ""}`} role="listbox" ref={listRef}>
          {entries.map((entry, index) => (
            <button
              type="button"
              role="option"
              aria-selected={entry.value === selected?.value}
              data-highlight={index === highlight ? "1" : undefined}
              key={String(entry.value)}
              className={`kselect-item${entry.value === selected?.value ? " selected" : ""}${index === highlight ? " active" : ""}`}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => choose(entry)}
            >
              <span className="kselect-item-label">{entry.label}</span>
              {entry.value === selected?.value ? <Check /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
