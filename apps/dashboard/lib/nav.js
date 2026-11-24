import {
  Ban,
  Boxes,
  Cpu,
  Grid3x3,
  LayoutDashboard,
  Radio,
  Rocket,
  ScrollText,
  Settings,
  ShieldAlert,
  Users,
} from "lucide-react";

export const NAV = [
  {
    group: "Monitor",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard, keywords: "dashboard home" },
      { href: "/feed", label: "Live feed", icon: Radio, keywords: "events stream" },
      { href: "/incidents", label: "Incidents", icon: ShieldAlert, keywords: "queue alerts" },
      { href: "/attackers", label: "Attackers", icon: Users, keywords: "sources ip" },
      {
        href: "/attack",
        label: "ATT&CK matrix",
        icon: Grid3x3,
        keywords: "mitre techniques tactics",
      },
    ],
  },
  {
    group: "Defense",
    items: [
      {
        href: "/decoys",
        label: "Decoys & containment",
        icon: Boxes,
        keywords: "honeypots sensors",
      },
      { href: "/blocklist", label: "Blocklist", icon: Ban, keywords: "block deny ip" },
    ],
  },
  {
    group: "Trust",
    items: [{ href: "/audit", label: "Audit log", icon: ScrollText, keywords: "history actions" }],
  },
  {
    group: "System",
    items: [
      { href: "/settings", label: "Settings", icon: Settings, keywords: "project api keys" },
      { href: "/system", label: "System", icon: Cpu, keywords: "health jobs" },
      { href: "/onboarding", label: "Onboarding", icon: Rocket, keywords: "setup install" },
    ],
  },
];

/** Flat list of every page, in sidebar order (breadcrumb, command palette). */
export const NAV_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));

export function isActive(pathname, href) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
