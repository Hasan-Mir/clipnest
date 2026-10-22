import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface CustomSelectProps<T extends string | number> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

/**
 * Notion-style custom dropdown component replacing all native OS dropdown elements.
 */
export function CustomSelect<T extends string | number>({
  value,
  options,
  onChange,
  className = "",
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number }>({
    left: 0,
    top: 0,
    minWidth: 160,
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const selectedLabel = options.find((o) => o.value === value)?.label ?? String(value);

  useEffect(() => {
    if (open) {
      setFocusIdx(selectedIdx);
    }
  }, [open, selectedIdx]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      return;
    }
    const br = btnRef.current.getBoundingClientRect();
    const mw = menuRef.current?.offsetWidth ?? Math.max(160, br.width);
    const mh = menuRef.current?.offsetHeight ?? Math.min(260, options.length * 32 + 12);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = br.left;
    if (left + mw > vw - 6) {
      left = Math.max(6, br.right - mw);
    }
    left = Math.max(6, Math.min(left, vw - mw - 6));
    let top = br.bottom + 4;
    if (top + mh > vh - 6 && br.top - mh - 4 >= 6) {
      top = br.top - mh - 4;
    }
    top = Math.max(6, Math.min(top, vh - mh - 6));
    setPos({ left, top, minWidth: Math.max(140, br.width) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", () => setOpen(false));
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setFocusIdx((i) => (i + 1) % Math.max(1, options.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setFocusIdx((i) => (i - 1 + Math.max(1, options.length)) % Math.max(1, options.length));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const picked = options[focusIdx];
      if (picked !== undefined) {
        onChange(picked.value);
      }
      setOpen(false);
      btnRef.current?.focus();
    }
  };

  return (
    <div className={`cselect${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className="cselect-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className="cselect-label">{selectedLabel}</span>
        <span className="cselect-chev">
          <Icon name="chevronDown" size={12} />
        </span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="listbox"
          className="cselect-menu"
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            minWidth: pos.minWidth,
            maxHeight: Math.min(280, window.innerHeight - 16),
          }}
        >
          {options.map((opt, idx) => {
            const isSel = opt.value === value;
            const isFocus = idx === focusIdx;
            return (
              <div
                key={String(opt.value)}
                role="option"
                aria-selected={isSel}
                className={`cselect-opt${isSel ? " sel" : ""}${isFocus ? " focus" : ""}`}
                onMouseEnter={() => setFocusIdx(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className="cselect-opt-label">{opt.label}</span>
                {isSel && (
                  <span className="cselect-check">
                    <Icon name="check" size={12} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
