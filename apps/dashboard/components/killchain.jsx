"use client";
import { Check, Compass, FolderOpen, KeyRound, Radar, Terminal, Upload } from "lucide-react";
import { STAGE_LABEL, STAGES } from "@/lib/labels";
import { cn } from "@/lib/utils";

const ICONS = {
  recon: Radar,
  initial_access: KeyRound,
  execution: Terminal,
  discovery: Compass,
  collection: FolderOpen,
  exfiltration: Upload,
};

// Severity colour for reached stages. Literal class names so Tailwind can see them.
const SEV_BG = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};
const sevBg = (severity) => SEV_BG[severity] || SEV_BG.low;

/**
 * Six-stage kill chain as a compact stepper: horizontal ≥ md, vertical < md.
 * Reached = severity colour + check icon + aria-label (never colour alone).
 * `detail` (optional) maps stage → one-line evidence, shown as the step's tooltip.
 */
export function KillChain({ stages = [], severity = "critical", detail }) {
  const reached = new Set(stages);
  const bg = sevBg(severity);
  return (
    <ol aria-label="Kill chain" className="m-0 flex list-none flex-col p-0 md:flex-row">
      {STAGES.map((s, i) => {
        const on = reached.has(s);
        const next = STAGES[i + 1];
        const Icon = on ? Check : ICONS[s];
        const label = `${STAGE_LABEL[s]}: ${on ? "reached" : "not reached"}`;
        return (
          <li
            key={s}
            aria-label={label}
            title={detail?.[s] || label}
            className="relative flex min-w-0 flex-1 items-center gap-3 pb-3 last:pb-0 md:flex-col md:gap-1.5 md:pb-0 md:text-center"
          >
            {next ? (
              <span
                aria-hidden
                className={cn(
                  // vertical connector < md, horizontal ≥ md (circle centre → next circle centre)
                  "absolute top-6 bottom-0 left-3 w-px md:top-3 md:-right-1/2 md:bottom-auto md:left-1/2 md:mx-3 md:h-px md:w-auto",
                  on && reached.has(next) ? bg : "bg-border",
                )}
              />
            ) : null}
            <span
              aria-hidden
              className={cn(
                "relative flex size-6 shrink-0 items-center justify-center rounded-full",
                on ? cn(bg, "text-(--sev-on)") : "border border-border bg-card text-muted-foreground",
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <span
              className={cn(
                "min-w-0 text-sm md:text-xs",
                on ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {STAGE_LABEL[s]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Compact 6-segment mini bar for tables and lists. */
export function KillMini({ stages = [], severity = "critical", className }) {
  const reached = new Set(stages);
  const bg = sevBg(severity);
  const label = `${stages.length} of 6 kill-chain stages reached`;
  return (
    <span
      role="img"
      aria-label={label}
      title={stages.length ? stages.map((s) => STAGE_LABEL[s]).join(" → ") : "No stages reached"}
      className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
    >
      {STAGES.map((s) => (
        <span
          key={s}
          className={cn("h-1.5 w-3 rounded-sm", reached.has(s) ? bg : "bg-muted ring-1 ring-border ring-inset")}
        />
      ))}
    </span>
  );
}
