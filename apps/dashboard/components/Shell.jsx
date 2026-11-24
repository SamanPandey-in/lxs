"use client";
import {
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  FlaskConical,
  LogOut,
  Menu,
  Moon,
  RotateCw,
  Search,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { Badge, Count } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getAllowMock, loadConfig } from "../lib/config";
import { api, coreUrl, resolveProject, setActiveProject } from "../lib/core";
import { useApiProblem, useDemo } from "../lib/hooks";
import { setMe } from "../lib/identity";
import { isActive, NAV, NAV_ITEMS } from "../lib/nav";
import { useStore } from "../lib/store";
import { CommandPalette, Kbd, useModKeyLabel, usePaletteShortcut } from "./command-palette";
import { SampleDataBanner } from "./sample-data-banner";
import { PageSkeleton } from "./ui";
import { VerifyEmailBanner } from "./verify-email-banner";

/*
 * App shell (agents/ui/layout.md → The shell, visual-language.md §1).
 *
 * Layering: window + sidebar are one `bg-chrome` surface; topbar + page live in a raised panel.
 *   ≥ 1024  232 px sidebar · panel inset 8 px (m-2 ml-0), rounded-xl, border, shadow-panel
 *   768–1023 56 px icon rail with tooltips · panel full-bleed
 *   < 768   hamburger → left Sheet · panel full-bleed
 *
 * Scrolling: ≥ 768 the shell is exactly one viewport tall and the PANEL is the scroll container
 * (`data-scroll-root`), so the sticky topbar (top-0) and any sticky page bar (top-12) stick to
 * the panel, not the window. < 768 the document scrolls as usual; the same classes still work.
 *
 * The shell renders immediately; the session check happens inside the content area.
 */

const PUBLIC = new Set([
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/digest/unsubscribe",
]);
const isPublic = (path) => PUBLIC.has(path) || path?.startsWith("/invite/");
const OPEN = new Set(["open", "acknowledged"]);

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function Shell({ children }) {
  const path = usePathname();
  if (isPublic(path)) return children;
  return <AppShell path={path}>{children}</AppShell>;
}

/** checking → authenticated | mock | error. 401/403 redirect to /login. Also returns the /v1/me user. */
function useSession(path) {
  const [state, setState] = useState("checking");
  const [user, setUser] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    let active = true;
    // `attempt` re-runs the check on Retry.
    void attempt;
    setState("checking");
    // Runtime config first: until it loads, coreUrl() is only the build-time default.
    const fallback = () => (getAllowMock() ? "mock" : "error");
    loadConfig()
      .then(() => fetch(`${coreUrl()}/v1/me`, { credentials: "include", cache: "no-store" }))
      .then((response) => {
        if (!active) return;
        if (response.ok) {
          setState("authenticated");
          response
            .json()
            .then((body) => {
              setMe(body);
              if (active) setUser(body?.user ?? null);
            })
            .catch(() => {});
        } else if (response.status === 401 || response.status === 403) {
          window.location.replace(`/login?next=${encodeURIComponent(pathRef.current)}`);
        } else setState(fallback());
      })
      .catch(() => active && setState(fallback()));
    return () => {
      active = false;
    };
  }, [attempt]);
  return [state, user, () => setAttempt((n) => n + 1)];
}

/** Projects for the workspace switcher. */
function useProjects(enabled) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    Promise.all([api.projects(), resolveProject()])
      .then(([items, selected]) => {
        if (!active) return;
        setProjects(items || []);
        setProjectId(selected);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [enabled]);
  return { projects, projectId };
}

/** Open (or acknowledged) critical incidents. Only call once the session is ready (starts the store). */
function useOpenCritical() {
  const st = useStore();
  let n = 0;
  for (const i of st.incidents.values())
    if (OPEN.has(i.status) && i.severity === "critical") n += 1;
  return { count: n, known: st.bootstrapped };
}

function AppShell({ children, path }) {
  const [session, user, retry] = useSession(path);
  const ready = session === "authenticated" || session === "mock";
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const workspace = useProjects(ready);
  const scrollRef = useRef(null);
  const triggerRef = useRef(null);

  usePaletteShortcut((next) => setPaletteOpen((o) => (next === true ? true : !o)));

  // The panel is the scroll container ≥ 768, which Next's scroll-to-top doesn't reset reliably.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on every route change
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [path]);

  const sidebarFooter = (rail) => (
    <div className="flex flex-none flex-col gap-1 px-2 pt-2 pb-2">
      <div className={cn("px-2 pb-1 text-xs text-muted-foreground", rail && "hidden lg:block")}>
        {ready ? <DecoyCount /> : " "}
      </div>
      <UserMenu user={user} mock={session === "mock"} rail={rail} />
    </div>
  );

  return (
    <TooltipProvider delay={400}>
      <div
        data-shell
        className="shell grid min-h-dvh grid-cols-1 bg-chrome md:h-dvh md:grid-cols-[56px_minmax(0,1fr)] md:grid-rows-1 md:overflow-hidden lg:grid-cols-[232px_minmax(0,1fr)]"
      >
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 text-base font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <aside className="sidebar hidden h-dvh min-h-0 flex-col bg-chrome md:flex">
          <WorkspaceSwitcher {...workspace} rail />
          <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <NavList path={path} ready={ready} rail />
          </nav>
          {sidebarFooter(true)}
        </aside>

        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="w-[min(288px,85vw)] gap-0 border-0 bg-chrome p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <WorkspaceSwitcher {...workspace} onNavigate={() => setNavOpen(false)} />
            <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              <NavList path={path} ready={ready} onNavigate={() => setNavOpen(false)} />
            </nav>
            {sidebarFooter(false)}
          </SheetContent>
        </Sheet>

        <div
          ref={scrollRef}
          data-scroll-root
          className={cn(
            "panel flex min-w-0 flex-col bg-background",
            "md:min-h-0 md:overflow-y-auto md:border-l md:border-border",
            "lg:m-2 lg:ml-0 lg:rounded-xl lg:border lg:shadow-panel dark:lg:shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]",
          )}
        >
          <header className="topbar sticky top-0 z-20 flex h-12 min-w-0 flex-none items-center gap-2 border-b border-border bg-background px-4 md:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="-ml-1 md:hidden"
              aria-label="Open navigation"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Menu aria-hidden />
            </Button>
            <Crumbs path={path} ready={ready} />
            <span className="min-w-0 flex-1" />
            <PaletteTrigger ref={triggerRef} onOpen={() => setPaletteOpen(true)} />
            {ready ? <TopbarStatus /> : null}
          </header>
          {ready ? <StatusBanner /> : null}
          {session === "authenticated" ? <VerifyEmailBanner /> : null}
          {session === "authenticated" ? <SampleDataBanner /> : null}
          <main
            id="main"
            tabIndex={-1}
            className="page mx-auto w-full max-w-[1280px] min-w-0 flex-1 px-4 py-4 outline-none md:px-6 md:py-6"
          >
            {ready ? (
              children
            ) : session === "error" ? (
              <SessionError onRetry={retry} />
            ) : (
              <PageSkeleton label="Checking your session" />
            )}
          </main>
        </div>
      </div>
      {ready ? (
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          returnFocusRef={triggerRef}
        />
      ) : null}
      <Toaster position="bottom-right" richColors />
    </TooltipProvider>
  );
}

/* ───────── Sidebar ───────── */

function BrandMark() {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]"
    >
      L
    </span>
  );
}

/**
 * Top of the sidebar: brand mark + project name. With more than one project it is a menu that
 * switches the active project (reloads); with one it links to the overview.
 */
function WorkspaceSwitcher({ projects, projectId, rail = false, onNavigate }) {
  const current = projects.find((p) => p.id === projectId);
  const name = current?.name || "LXS";
  const multi = projects.length > 1;
  const cls = cn(
    "flex h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm font-medium text-sidebar-foreground transition-colors duration-150",
    focusRing,
    rail && "md:justify-center md:px-0 lg:justify-start lg:px-2",
  );
  const label = (
    <span className={cn("min-w-0 flex-1 truncate", rail && "md:hidden lg:inline")}>{name}</span>
  );

  return (
    <div className="flex h-14 flex-none items-center px-2">
      {multi ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Project: ${name}. Switch project`}
            className={cn(cls, "hover:bg-sidebar-accent/60 aria-expanded:bg-sidebar-accent/60")}
          >
            <BrandMark />
            {label}
            <ChevronsUpDown
              aria-hidden
              className={cn("size-4 shrink-0 text-muted-foreground", rail && "md:hidden lg:inline")}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side={rail ? "right" : "bottom"} className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={projectId}
                onValueChange={(v) => {
                  if (v === projectId) return;
                  setActiveProject(v);
                  window.location.reload();
                }}
              >
                {projects.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id}>
                    <span className="min-w-0 truncate">{p.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Link
          href="/dashboard"
          prefetch={false}
          onClick={onNavigate}
          aria-label={`${name} overview`}
          className={cn(cls, "hover:bg-sidebar-accent/60")}
        >
          <BrandMark />
          {label}
        </Link>
      )}
    </div>
  );
}

/** Nav groups. `rail` = the md icon rail: labels hidden 768–1023 with tooltips instead. */
function NavList({ path, ready, rail = false, onNavigate }) {
  return NAV.map((g) => (
    <div key={g.group} className="mt-4 first:mt-1">
      <div
        className={cn(
          "px-2 pb-1 text-xs font-medium text-faint",
          rail && "md:sr-only lg:not-sr-only",
        )}
      >
        {g.group}
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {g.items.map(({ href, label, icon: Icon }) => {
          const current = isActive(path, href);
          const count = ready && href === "/incidents" ? <CriticalCount rail={rail} /> : null;
          const link = (
            <Link
              href={href}
              // 11 sidebar links on every page would prefetch 11 routes per navigation.
              prefetch={false}
              onClick={onNavigate}
              aria-current={current ? "page" : undefined}
              className={cn(
                "nav-item relative flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors duration-150",
                focusRing,
                current
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-card dark:shadow-none"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                rail && "md:justify-center md:px-0 lg:justify-start lg:px-2",
              )}
            />
          );
          const inner = (
            <>
              <Icon
                aria-hidden
                className={cn(
                  "size-4 shrink-0",
                  current ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className={cn("min-w-0 flex-1 truncate", rail && "md:sr-only lg:not-sr-only")}>
                {label}
              </span>
              {count}
            </>
          );
          return (
            <li key={href}>
              {rail ? (
                <Tooltip>
                  <TooltipTrigger render={link}>{inner}</TooltipTrigger>
                  <TooltipContent side="right" className="lg:hidden">
                    {label}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Link {...link.props}>{inner}</Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  ));
}

/** Count pill on the Incidents nav item: open critical incidents. Red tint only when > 0. */
function CriticalCount({ rail }) {
  const { count, known } = useOpenCritical();
  if (!known) return null;
  return (
    <>
      <Count
        className={cn(
          count > 0 && "bg-destructive/10 text-destructive dark:bg-destructive/15",
          rail && "md:hidden lg:inline-flex",
        )}
      >
        {count}
        <span className="sr-only"> open critical</span>
      </Count>
      {rail && count > 0 ? (
        <span
          aria-hidden
          className="absolute top-1.5 right-3 hidden size-1.5 rounded-full bg-destructive md:block lg:hidden"
        />
      ) : null}
    </>
  );
}

function DecoyCount() {
  const st = useStore();
  const online = st.decoys.filter((d) => d.status === "online").length;
  const tone =
    st.decoys.length === 0
      ? "bg-muted-foreground"
      : online === st.decoys.length
        ? "bg-ok"
        : "bg-warn";
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone)} />
      {st.decoys.length} decoys · {online} online
    </span>
  );
}

function initialsOf(user) {
  const name = (user?.name || "").trim();
  if (name) {
    const parts = name.split(/\s+/);
    return (
      (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
    ).toUpperCase();
  }
  const handle = user?.username || user?.email || "";
  return handle.slice(0, 2).toUpperCase() || "?";
}

function useThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  return { dark, toggle: () => setTheme(dark ? "light" : "dark") };
}

async function logout() {
  try {
    await fetch(`${coreUrl()}/v1/auth/logout`, { method: "POST", credentials: "include" });
  } finally {
    window.location.replace("/");
  }
}

/** Bottom of the sidebar: avatar + name/email → theme toggle, log out. */
function UserMenu({ user, mock, rail }) {
  const { dark, toggle } = useThemeToggle();
  const name = user?.name || user?.username || (mock ? "Mock session" : "Signed in");
  const email = user?.email || (mock ? "No real account" : "");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${name}`}
        className={cn(
          "flex h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors duration-150 hover:bg-sidebar-accent/60 aria-expanded:bg-sidebar-accent/60",
          focusRing,
          rail && "md:justify-center md:px-0 lg:justify-start lg:px-2",
        )}
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-medium text-foreground"
        >
          {initialsOf(user)}
        </span>
        <span className={cn("flex min-w-0 flex-1 flex-col", rail && "md:hidden lg:flex")}>
          <span className="truncate text-sm font-medium text-sidebar-foreground">{name}</span>
          {email ? <span className="truncate text-xs text-muted-foreground">{email}</span> : null}
        </span>
        <ChevronsUpDown
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground", rail && "md:hidden lg:inline")}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={rail ? "right" : "top"}
        sideOffset={6}
        className="w-60"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 py-1.5">
            <span className="truncate text-sm font-medium text-foreground">{name}</span>
            {email ? <span className="truncate text-xs font-normal">{email}</span> : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem closeOnClick={false} onClick={toggle}>
          {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
          Switch to {dark ? "light" : "dark"} theme
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout}>
          <LogOut aria-hidden />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ───────── Topbar ───────── */

function Crumbs({ path, ready }) {
  const cur = NAV_ITEMS.find((i) => isActive(path, i.href));
  const parts = path.split("/").filter(Boolean);
  const leafId = parts.length > 1 ? parts[1] : null;
  return (
    <nav aria-label="Breadcrumb" className="crumbs min-w-0 truncate text-sm text-muted-foreground">
      {leafId ? (
        <>
          <Link
            href={cur?.href || "/dashboard"}
            className={cn("rounded-sm hover:text-foreground", focusRing)}
          >
            {cur?.label ?? "LXS"}
          </Link>
          <ChevronRight aria-hidden className="mx-1 inline size-3.5 align-[-2px]" />
          <span aria-current="page" className="font-medium text-foreground">
            {ready && parts[0] === "incidents" ? <IncidentLeaf id={leafId} /> : leafId}
          </span>
        </>
      ) : (
        <span aria-current="page" className="font-medium text-foreground">
          {cur?.label ?? "LXS"}
        </span>
      )}
    </nav>
  );
}

function IncidentLeaf({ id }) {
  const st = useStore();
  const inc = st.incidents.get(id);
  return inc ? `#${inc.number}` : id;
}

/** Search-looking button that opens the ⌘K palette. Icon-only below 640 px. */
function PaletteTrigger({ ref, onOpen }) {
  const mod = useModKeyLabel();
  return (
    <Button
      ref={ref}
      variant="outline"
      onClick={onOpen}
      aria-label="Search or jump to…"
      aria-keyshortcuts="Meta+K Control+K"
      aria-haspopup="dialog"
      className="w-8 justify-center gap-2 px-0 font-normal text-muted-foreground hover:text-foreground sm:w-64 sm:justify-start sm:pr-1.5 sm:pl-2.5"
    >
      <Search aria-hidden className="size-4 text-muted-foreground" />
      <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">Search or jump to…</span>
      <Kbd className="hidden sm:inline-flex">{mod}</Kbd>
    </Button>
  );
}

const CONN = {
  live: ["bg-ok", "Live"],
  demo: ["bg-link", "Simulated stream"],
  connecting: ["bg-warn", "Connecting…"],
  reconnecting: ["bg-warn", "Reconnecting…"],
  offline: ["bg-destructive", "Offline"],
};

/** Live status + critical count: the only place global counts appear (G3). */
function TopbarStatus() {
  const st = useStore();
  const { count: crit, known } = useOpenCritical();
  const [dot, label] = CONN[st.conn] ?? CONN.offline;
  const live = st.conn === "live" || st.conn === "demo";

  return (
    <div className="flex min-w-0 items-center gap-1 sm:gap-2">
      <span
        aria-live="polite"
        className="hidden items-center gap-2 px-2 text-sm text-foreground sm:inline-flex"
      >
        <span aria-hidden className="relative flex size-2 shrink-0">
          {live ? (
            <span
              className={cn(
                "absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping",
                dot,
              )}
            />
          ) : null}
          <span className={cn("relative size-2 rounded-full", dot)} />
        </span>
        {label}
      </span>
      {known ? (
        <Link
          href="/incidents?severity=critical"
          prefetch={false}
          title="Open critical incidents (open or acknowledged)"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
            focusRing,
          )}
        >
          {crit > 0 ? (
            <Badge variant="severity" tone="critical" className="tabular-nums">
              {crit}
            </Badge>
          ) : (
            <span className="font-medium tabular-nums">0</span>
          )}
          critical
        </Link>
      ) : null}
    </div>
  );
}

function SessionError({ onRetry }) {
  return (
    <div
      role="alert"
      className="mx-auto mt-10 flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-card px-6 py-10 text-center shadow-card"
    >
      <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-destructive">
        <CircleAlert className="size-5" aria-hidden />
      </div>
      <h1 className="m-0 text-base font-medium text-foreground">Couldn't verify your session</h1>
      <p className="m-0 text-sm text-muted-foreground">
        The platform API at {coreUrl()} didn't answer. Check that it's running, then retry.
      </p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        <RotateCw aria-hidden /> Retry
      </Button>
    </div>
  );
}

const PROBLEM_TITLE = {
  session: "Not signed in: the API rejected this session",
  forbidden: "Permission denied: this account's role cannot see part of this page",
  network: "Platform API unreachable",
  timeout: "Platform API is not responding in time",
  server: "Platform API is returning errors",
};

/** Failures are never quiet. Nothing here can be dismissed; it clears when the cause does. */
function StatusBanner() {
  const demo = useDemo();
  const problem = useApiProblem();
  if (!demo && !problem) return null;
  const Icon = demo ? FlaskConical : CircleAlert;
  return (
    <div
      role="alert"
      className={cn(
        "flex min-w-0 items-start gap-2 border-b px-4 py-2 text-sm text-foreground md:px-6",
        demo
          ? "border-warn/40 bg-warn/10 dark:bg-warn/15"
          : "border-destructive/40 bg-destructive/10 dark:bg-destructive/15",
      )}
    >
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", demo ? "text-warn" : "text-destructive")}
      />
      {demo ? (
        <span>
          <strong className="font-semibold">Mock data: nothing on this screen is real.</strong> The
          API at {coreUrl()} is unavailable and LXS_ALLOW_MOCK=1 is set. Actions still go to the
          real API and will fail.
        </span>
      ) : (
        <span>
          <strong className="font-semibold">{PROBLEM_TITLE[problem.kind]}.</strong>{" "}
          {problem.message}. Anything on screen is from the last successful refresh.
        </span>
      )}
    </div>
  );
}
