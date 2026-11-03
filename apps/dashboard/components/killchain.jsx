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

/** Six-stage kill chain (kc-* classes). */
export function KillChain({ stages = [], severity = "critical", detail }) {
  const reached = new Set(stages);
  const lastIdx = Math.max(...STAGES.map((s, i) => (reached.has(s) ? i : -1)));
  return (
    <div className="kc" data-sev={severity} role="list" aria-label="Kill chain stages reached">
      {STAGES.map((s, i) => {
        const on = reached.has(s);
        const Icon = on ? Check : ICONS[s];
        return (
          <div className="kc-seg" key={s} role="listitem">
            <div
              className={cn("kc-block", on && "is-on", on && i === lastIdx && "is-last")}
              title={detail?.[s] || STAGE_LABEL[s]}
            >
              <span className="kc-ico">
                <Icon aria-hidden />
              </span>
              <span className="kc-name">{STAGE_LABEL[s]}</span>
              <span className="kc-state">
                {on ? (detail?.[s] ? detail[s] : "Reached") : "Not reached"}
              </span>
            </div>
            <span
              className={cn("kc-link", on && reached.has(STAGES[i + 1]) && "is-on")}
              aria-hidden
            />
          </div>
        );
      })}
    </div>
  );
}

/** Compact 6-segment mini-bar for tables. */
export function KillMini({ stages = [], severity = "critical" }) {
  const reached = new Set(stages);
  return (
    <span
      className="killmini"
      data-sev={severity}
      title={stages.length ? stages.map((s) => STAGE_LABEL[s]).join(" → ") : "No stages"}
      aria-label={`${stages.length} of 6 kill-chain stages reached`}
    >
      {STAGES.map((s) => (
        <span key={s} className={reached.has(s) ? "is-on" : undefined} />
      ))}
    </span>
  );
}
