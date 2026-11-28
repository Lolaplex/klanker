import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  id: string;
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

type ContextMenuEventLike = {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
};

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuValue {
  openMenu: (event: ContextMenuEventLike, items: ContextMenuItem[]) => void;
  closeMenu: () => void;
}

const noopContext: ContextMenuValue = {
  openMenu: () => {},
  closeMenu: () => {},
};

const ContextMenuContext = createContext<ContextMenuValue>(noopContext);

export function useContextMenu(): ContextMenuValue {
  return useContext(ContextMenuContext);
}

const clampInside = (value: number, size: number, viewport: number, margin: number) => {
  const max = viewport - size - margin;
  if (max < margin) return margin;
  return Math.max(margin, Math.min(value, max));
};

/** Universal monochrome right-click menu (Wave 9A): portal-rendered,
 *  viewport-clamped, keyboard navigable and dismissible without owning the
 *  caller's row semantics. */
export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [activeIndex, setActiveIndex] = useState(-1);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((event: ContextMenuEventLike, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const next = { x: event.clientX, y: event.clientY, items };
    setPos({ x: next.x, y: next.y });
    setMenu(next);
  }, []);

  const selectable = useMemo(
    () => (menu?.items || [])
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.separator && !item.disabled),
    [menu]
  );

  useEffect(() => {
    itemRefs.current = [];
    setActiveIndex(selectable[0]?.index ?? -1);
  }, [menu, selectable]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const width = rect.width || el.offsetWidth || 180;
    const height = rect.height || el.offsetHeight || Math.max(36, menu.items.length * 32 + 10);
    let x = menu.x;
    let y = menu.y;
    if (x + width + margin > window.innerWidth) {
      const flipped = x - width;
      x = flipped >= margin ? flipped : window.innerWidth - width - margin;
    }
    if (y + height + margin > window.innerHeight) {
      const flipped = y - height;
      y = flipped >= margin ? flipped : window.innerHeight - height - margin;
    }
    const next = {
      x: clampInside(x, width, window.innerWidth, margin),
      y: clampInside(y, height, window.innerHeight, margin),
    };
    setPos((cur) => (Math.abs(cur.x - next.x) < 0.5 && Math.abs(cur.y - next.y) < 0.5 ? cur : next));
  }, [menu]);

  useEffect(() => {
    if (!menu || activeIndex < 0) return;
    itemRefs.current[activeIndex]?.focus({ preventScroll: true });
  }, [activeIndex, menu]);

  useEffect(() => {
    if (!menu) return;

    const move = (delta: number) => {
      if (!selectable.length) return;
      setActiveIndex((cur) => {
        const positions = selectable.map(({ index }) => index);
        const at = Math.max(0, positions.indexOf(cur));
        return positions[(at + delta + positions.length) % positions.length];
      });
    };

    const activate = (index: number) => {
      const item = menu.items[index];
      if (!item || item.separator || item.disabled) return;
      closeMenu();
      item.onSelect?.();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (activeIndex >= 0) activate(activeIndex);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };
    const onDismiss = () => closeMenu();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [menu, activeIndex, selectable, closeMenu]);

  const value = useMemo(() => ({ openMenu, closeMenu }), [openMenu, closeMenu]);

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      {menu && typeof document !== "undefined" ? createPortal(
        <div className="pointer-events-none fixed inset-0 z-[90]" data-testid="context-menu-layer">
          <div
            ref={menuRef}
            role="menu"
            aria-label="Context menu"
            data-testid="context-menu"
            onContextMenu={(e) => e.preventDefault()}
            className="pointer-events-auto absolute bg-surface border border-subtle shadow-2xl rounded-md py-1 min-w-[180px] klanker-menu-enter"
            style={{ left: pos.x, top: pos.y }}
          >
            {menu.items.map((item, index) => {
              if (item.separator) {
                return <div key={item.id} role="separator" className="mx-1 my-1 h-px bg-subtle" />;
              }
              const active = index === activeIndex;
              return (
                <button
                  key={item.id}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  type="button"
                  role="menuitem"
                  aria-disabled={item.disabled || undefined}
                  data-menu-item={item.id}
                  disabled={item.disabled}
                  onMouseEnter={() => !item.disabled && setActiveIndex(index)}
                  onClick={() => {
                    if (item.disabled) return;
                    closeMenu();
                    item.onSelect?.();
                  }}
                  className={`flex min-h-8 w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] outline-none transition-colors ${
                    item.danger
                      ? "text-danger hover:bg-hover focus:bg-hover"
                      : active
                        ? "bg-hover text-ink-primary"
                        : "text-ink-secondary hover:bg-hover hover:text-ink-primary focus:bg-hover focus:text-ink-primary"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {item.icon ? <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">{item.icon}</span> : null}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.shortcut ? <kbd className="shrink-0 text-[9px] text-ink-dim">{item.shortcut}</kbd> : null}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      ) : null}
    </ContextMenuContext.Provider>
  );
}
