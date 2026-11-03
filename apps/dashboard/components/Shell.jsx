"use client";
import { ChevronRight, FlaskConical, Moon, Sun } from "lucide-react";
// App shell copied from the Genesis api-client and re-branded: healr -> LXS.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { coreUrl } from "../lib/core";
import { useDemo } from "../lib/hooks";
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

export default function Shell({ children }) {
  const path = usePathname();
  const st = useStore();
  const demo = useDemo();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
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
              title={`Platform API unreachable at ${coreUrl()}. Showing built-in demo data.`}
            >
              <FlaskConical size={12} aria-hidden /> Demo data
            </span>
          ) : null}
          <Connection conn={st.conn} />
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
        <main className="page">{children}</main>
      </div>
      <Toaster position="bottom-right" richColors />
    </div>
  );
}
