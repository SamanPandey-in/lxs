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
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/feed", label: "Live feed", icon: Radio },
      { href: "/incidents", label: "Incidents", icon: ShieldAlert },
      { href: "/attackers", label: "Attackers", icon: Users },
      { href: "/attack", label: "ATT&CK matrix", icon: Grid3x3 },
    ],
  },
  {
    group: "Defense",
    items: [
      { href: "/decoys", label: "Decoys & containment", icon: Boxes },
      { href: "/blocklist", label: "Blocklist", icon: Ban },
    ],
  },
  { group: "Trust", items: [{ href: "/audit", label: "Audit log", icon: ScrollText }] },
  {
    group: "System",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/system", label: "System", icon: Cpu },
      { href: "/onboarding", label: "Onboarding", icon: Rocket },
    ],
  },
];

export function isActive(pathname, href) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
