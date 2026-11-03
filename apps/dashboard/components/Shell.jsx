"use client";
import { ChevronRight, CircleAlert, FlaskConical, Moon, Sun } from "lucide-react";
// App shell copied from the Genesis api-client and re-branded: healr -> LXS.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { loadConfig } from "../lib/config";
import { api, coreUrl, resolveProject, setActiveProject } from "../lib/core";
import { useApiProblem, useDemo } from "../lib/hooks";
import { NAV } from "../lib/nav";
import { useStore } from "../lib/store";
import { Pill } from "./ui";

function Connection({ conn }) {
  const map = {
    live: ["live", "Live"],
    demo: ["cache", "Simulated stream"],
    connecting: ["drift", "Connecting"],
    reconnecting: ["drift", "Reconnecting"],
    offline: ["bad", "Platform offline"],
  };
  const [tone, label] = map[conn] ?? map.offline;
  return <Pill tone={tone}>{label}</Pill>;
}

const PROBLEM_TITLE = {
  session: "Not signed in: the API rejected this session",
  forbidden: "Permission denied: this account's role cannot see part of this page",
  network: "Platform API unreachable",
  timeout: "Platform API is not responding in time",
  server: "Platform API is returning errors",
};

/** Failures are never quiet. Nothing here can be dismissed; it clears when the cause does. */
function StatusBanner({ demo, problem }) {
  if (demo)
    return (
      <div className="api-alert" role="alert">
        <FlaskConical size={15} aria-hidden />
        <span>
          <strong>MOCK DATA: nothing on this screen is real.</strong> The API at {coreUrl()} is
          unavailable and LXS_ALLOW_MOCK=1 is set. Actions still go to the real API and will fail.
        </span>
      </div>
    );
  if (!problem) return null;
  return (
    <div className="api-alert" role="alert">
      <CircleAlert size={15} aria-hidden />
      <span>
        <strong>{PROBLEM_TITLE[problem.kind]}.</strong> {problem.message}. Anything on screen is
        from the last successful refresh.
      </span>
    </div>
  );
}

export default function Shell({ children }) {
  const path = usePathname();
  const isPublic = path === "/" || path === "/login" || path === "/signup";
  const [authState, setAuthState] = useState("checking");
  useEffect(() => {
    if (isPublic) return;
    let active = true;
    // Runtime config first: until it loads, coreUrl() is only the build-time default.
    loadConfig()
      .then(() => fetch(`${coreUrl()}/v1/me`, { credentials: "include", cache: "no-store" }))
      .then((response) => {
        if (!active) return;
        if (response.ok) setAuthState("authenticated");
        else if (response.status === 401 || response.status === 403) {
          window.location.replace(`/login?next=${encodeURIComponent(path)}`);
        } else setAuthState("error");
      })
      .catch(() => active && setAuthState("error"));
    return () => {
      active = false;
    };
  }, [path, isPublic]);

  if (isPublic) return children;
  if (authState !== "authenticated") {
    return (
      <main className="auth-screen">
        <p>
          {authState === "error"
            ? "Could not verify your session. Check that the API is available and reload."
            : "Checking your session…"}
        </p>
      </main>
    );
  }
  return <WorkspaceShell path={path}>{children}</WorkspaceShell>;
}

function WorkspaceShell({ children, path }) {
  const st = useStore();
  const demo = useDemo();
  const problem = useApiProblem();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    let active = true;
    Promise.all([api.projects(), resolveProject()])
      .then(([items, selected]) => {
        if (!active) return;
        setProjects(items);
        setProjectId(selected);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const dark = mounted && resolvedTheme === "dark";

  const active = (href) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  const items = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
  const cur = items.find((i) => active(i.href));
  const parts = path.split("/").filter(Boolean);
  const leafInc = parts[0] === "incidents" && parts[1] ? st.incidents.get(parts[1]) : null;
  const leaf = parts.length > 1 ? (leafInc ? `#${leafInc.number}` : parts[1]) : null;

  const open = [...st.incidents.values()].filter(
    (i) => i.status === "open" || i.status === "acknowledged",
  );
  const crit = open.filter((i) => i.severity === "critical").length;
  const high = open.filter((i) => i.severity === "high").length;
  const noise = st.overview?.noise_suppressed_24h;
  const online = st.decoys.filter((d) => d.status === "online").length;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="LXS home">
          <span className="brand-mark">L</span>
          <span>LXS</span>
        </Link>
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="nav-group">{g.group}</div>
            {g.items.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="nav-item"
                title={label}
                // 11 sidebar links on every page would prefetch 11 routes per navigation.
                prefetch={false}
                aria-current={active(href) ? "page" : undefined}
              >
                <Icon size={15} aria-hidden />
                <span>{label}</span>
                {href === "/incidents" && crit > 0 ? (
                  <span className="nav-badge">{crit}</span>
                ) : null}
              </Link>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          {st.decoys.length} decoys · {online} online
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <span className="crumbs">
            {leaf ? (
              <>
                <Link href={cur?.href || "/"}>{cur?.label}</Link>
                <ChevronRight size={12} className="sep" />
                <b>{leaf}</b>
              </>
            ) : (
              <b>{cur?.label ?? "LXS"}</b>
            )}
          </span>
          <span className="grow" />
          {projects.length > 1 ? (
            <label className="project-select-label">
              <span className="sr-only">Active project</span>
              <select
                className="project-select"
                aria-label="Active project"
                value={projectId}
                onChange={(event) => {
                  setActiveProject(event.target.value);
                  window.location.reload();
                }}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {st.overview ? (
            <span className="sev-summary" role="group" aria-label="Severity summary">
              <span>
                <b style={{ color: "var(--bad)" }}>{crit}</b> critical
              </span>
              <span>
                <b style={{ color: "var(--drift)" }}>{high}</b> high
              </span>
              <span>
                <b>{noise != null ? noise.toLocaleString("en-US") : "—"}</b> noise suppressed
              </span>
            </span>
          ) : null}
          {demo ? (
            <span
              className="demo-badge"
              title={`Platform API unavailable at ${coreUrl()}. Showing built-in mock data.`}
            >
              <FlaskConical size={12} aria-hidden /> Mock data
            </span>
          ) : null}
          <Connection conn={st.conn} />
          <button
            className="btn btn-sm"
            type="button"
            onClick={async () => {
              try {
                await fetch(`${coreUrl()}/v1/auth/logout`, {
                  method: "POST",
                  credentials: "include",
                });
              } finally {
                window.location.replace("/");
              }
            }}
          >
            Log out
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
            title="Toggle color theme"
            onClick={() => setTheme(dark ? "light" : "dark")}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
        <StatusBanner demo={demo} problem={problem} />
        <main className="page">{children}</main>
      </div>
      <Toaster position="bottom-right" richColors />
    </div>
  );
}
