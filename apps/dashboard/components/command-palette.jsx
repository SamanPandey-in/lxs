"use client";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Ban, CornerDownLeft, FlaskConical, Moon, Search, ShieldAlert, Sun } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { api, PROJECT } from "../lib/core";
import { NAV_ITEMS } from "../lib/nav";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { SeverityPill } from "./ui";

/*
 * ⌘K command palette (agents/ui/visual-language.md §7).
 * APG combobox + listbox: focus stays in the input, ↑/↓ move aria-activedescendant,
 * Enter runs the active option, Esc closes and Base UI returns focus to where it was.
 * Pages and incidents are real links (middle-click / ⌘-click open a new tab).
 */

// Kbd lives in components/ui/kbd.jsx; re-exported for existing imports.
export { Kbd };

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. Resolved after mount (no SSR mismatch). */
export function useModKeyLabel() {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
    setMac(/mac|iphone|ipad|ipod/i.test(p));
  }, []);
  return mac ? "⌘K" : "Ctrl K";
}

function isEditable(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el.getAttribute("type") || "text").toLowerCase();
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
    type,
  );
}

/**
 * Global shortcuts: ⌘K / Ctrl+K toggles anywhere; "/" opens when focus isn't in a text field.
 * `onToggle(next?)`: called with `true` to open, no argument to toggle.
 */
export function usePaletteShortcut(onToggle) {
  const ref = useRef(onToggle);
  ref.current = onToggle;
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target;
        if (isEditable(t) || isEditable(document.activeElement)) return;
        // Another dialog owns the keyboard.
        if (t instanceof Element && t.closest("[role=dialog],[role=alertdialog]")) return;
        e.preventDefault();
        ref.current(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const OPEN = new Set(["open", "acknowledged"]);
const MAX_INCIDENTS = 8;

const norm = (v) => String(v ?? "").toLowerCase();

function matchIncident(i, q) {
  if (!q) return true;
  const num = String(i.number ?? "");
  if (q.startsWith("#")) return num.startsWith(q.slice(1));
  return num.startsWith(q) || norm(i.src_ip).includes(q) || norm(i.title).includes(q);
}

export function CommandPalette({ open, onOpenChange, returnFocusRef }) {
  const router = useRouter();
  const st = useStore();
  const { resolvedTheme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const lastFocus = useRef(null);
  const inputRef = useRef(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  // Remember where focus was so Esc / run returns there (the trigger, or wherever ⌘K was pressed).
  useEffect(() => {
    if (open) {
      const el = document.activeElement;
      lastFocus.current = el instanceof HTMLElement && el !== document.body ? el : null;
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const q = norm(query.trim());
  const dark = resolvedTheme === "dark";

  const groups = useMemo(() => {
    const pages = NAV_ITEMS.filter(
      (p) =>
        !q ||
        norm(p.label).includes(q) ||
        norm(p.keywords).includes(q) ||
        norm(p.group).includes(q),
    ).map((p) => ({
      key: `page:${p.href}`,
      kind: "link",
      href: p.href,
      icon: p.icon,
      label: p.label,
      hint: p.group,
    }));

    const incidents = st.incidentOrder
      .map((id) => st.incidents.get(id))
      .filter((i) => i && OPEN.has(i.status) && matchIncident(i, q))
      .slice(0, MAX_INCIDENTS)
      .map((i) => ({
        key: `inc:${i.id}`,
        kind: "link",
        href: `/incidents/${i.id}`,
        incident: i,
      }));

    const actions = [
      {
        key: "act:theme",
        kind: "action",
        icon: dark ? Sun : Moon,
        label: `Switch to ${dark ? "light" : "dark"} theme`,
        keywords: "toggle theme dark light mode appearance",
        run: () => setTheme(dark ? "light" : "dark"),
      },
      {
        key: "act:simulate",
        kind: "action",
        icon: FlaskConical,
        label: "Run simulation",
        keywords: "replay scenario demo attack",
        run: async () => {
          try {
            await api.replay(PROJECT, { scenario: "ps-use-case" });
            toast("Simulation started", "success", "Replaying the SSH to payments scenario.");
          } catch (e) {
            toast("Couldn't start the simulation", "error", e.message);
          }
        },
      },
      {
        key: "act:block",
        kind: "link",
        href: "/blocklist",
        icon: Ban,
        label: "Add block",
        hint: "Opens Blocklist",
        keywords: "block ip deny blocklist",
      },
    ].filter((a) => !q || norm(a.label).includes(q) || norm(a.keywords).includes(q));

    return [
      { heading: "Pages", items: pages },
      { heading: "Incidents", items: incidents },
      { heading: "Actions", items: actions },
    ].filter((g) => g.items.length);
  }, [q, st.incidentOrder, st.incidents, dark, setTheme]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const activeIndex = flat.length ? Math.min(active, flat.length - 1) : -1;
  const optionId = (i) => `${baseId}-opt-${i}`;

  // Reset to the first result whenever the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the query only
  useEffect(() => setActive(0), [q]);

  // Keep the active option in view while arrowing.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  });

  const close = () => onOpenChange(false);

  const run = (item) => {
    close();
    if (item.kind === "link") router.push(item.href);
    else item.run();
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + flat.length) % flat.length);
    } else if (e.key === "Home" && flat.length && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && flat.length && e.ctrlKey) {
      e.preventDefault();
      setActive(flat.length - 1);
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (activeIndex >= 0) run(flat[activeIndex]);
    }
  };

  let index = -1;

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPortal>
        <DialogOverlay className="bg-black/40 backdrop-blur-[4px]" />
        <DialogPrimitive.Popup
          data-slot="command-palette"
          initialFocus={inputRef}
          finalFocus={() => lastFocus.current ?? returnFocusRef?.current ?? true}
          className="fixed top-[12dvh] left-1/2 z-50 flex max-h-[min(560px,76dvh)] w-[min(640px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-pop outline-none duration-150 ease-out data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <div className="flex h-12 flex-none items-center gap-2.5 border-b border-border px-4">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              aria-label="Search pages, incidents and actions"
              placeholder="Search pages, incidents by #id, IP or title…"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Kbd className="hidden sm:inline-flex">esc</Kbd>
          </div>

          <div
            id={listId}
            role="listbox"
            aria-label="Results"
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {flat.length === 0 ? (
              <p className="m-0 px-3 py-8 text-center text-sm text-muted-foreground">
                No results for “{query.trim()}”
              </p>
            ) : (
              groups.map((g) => {
                const headingId = `${baseId}-${g.heading}`;
                return (
                  <div
                    key={g.heading}
                    role="group"
                    aria-labelledby={headingId}
                    className="pb-1 not-first:pt-2"
                  >
                    <div id={headingId} className="px-2 pb-1 text-xs font-medium text-faint">
                      {g.heading}
                    </div>
                    {g.items.map((item) => {
                      index += 1;
                      const i = index;
                      return (
                        <Option
                          key={item.key}
                          id={optionId(i)}
                          item={item}
                          active={i === activeIndex}
                          onHover={() => setActive(i)}
                          onRun={() => run(item)}
                          onNavigate={close}
                        />
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          <div className="flex h-10 flex-none items-center gap-4 border-t border-border bg-muted/50 px-4 text-xs text-muted-foreground max-sm:hidden">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to navigate
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft aria-hidden className="size-3" />
                <span className="sr-only">Enter</span>
              </Kbd>
              to open
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>esc</Kbd> to close
            </span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}

const optionClass =
  "flex h-10 min-w-0 cursor-default items-center gap-3 rounded-lg px-2 text-sm text-foreground no-underline outline-none select-none data-[active=true]:bg-muted";

function Option({ id, item, active, onHover, onRun, onNavigate }) {
  const inc = item.incident;
  const Icon = inc ? ShieldAlert : item.icon;
  const body = inc ? (
    <>
      <SeverityPill severity={inc.severity} />
      <span className="shrink-0 text-muted-foreground tabular-nums">#{inc.number}</span>
      <span className="min-w-0 flex-1 truncate">{inc.title}</span>
      {inc.src_ip ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground max-sm:hidden">
          {inc.src_ip}
        </span>
      ) : null}
    </>
  ) : (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint ? (
        <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">{item.hint}</span>
      ) : null}
    </>
  );
  const enter = active ? (
    <CornerDownLeft aria-hidden className="size-3.5 shrink-0 text-muted-foreground max-sm:hidden" />
  ) : null;

  if (item.kind === "link") {
    return (
      <Link
        id={id}
        href={item.href}
        prefetch={false}
        role="option"
        aria-selected={active}
        tabIndex={-1}
        data-active={active}
        onMouseMove={active ? undefined : onHover}
        // Plain click: Link navigates client-side; modified clicks open a new tab as usual.
        onClick={(e) => {
          if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) onNavigate();
        }}
        className={optionClass}
      >
        {body}
        {enter}
      </Link>
    );
  }
  return (
    // Keyboard is handled by the combobox input (aria-activedescendant); this is the pointer path.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox input
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      data-active={active}
      onMouseMove={active ? undefined : onHover}
      onClick={onRun}
      className={optionClass}
    >
      {body}
      {enter}
    </div>
  );
}
