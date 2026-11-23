"use client";
import { Grid3x3 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, ErrorState, PageHeader, ScrollShadow, TableSkeleton } from "@/components/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FilterSelect, SectionCard } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useAsync } from "@/lib/hooks";
import { TECHNIQUES } from "@/lib/mock";
import { cn, fmtNum } from "@/lib/utils";

// MITRE ATT&CK Enterprise tactic order (M1). Unknown tactics sort after these.
const TACTIC_ORDER = [
  "reconnaissance",
  "resource development",
  "initial access",
  "execution",
  "persistence",
  "privilege escalation",
  "defense evasion",
  "credential access",
  "discovery",
  "lateral movement",
  "collection",
  "command and control",
  "exfiltration",
  "impact",
];
const tacticKey = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tacticRank = (t) => {
  const i = TACTIC_ORDER.indexOf(tacticKey(t));
  return i === -1 ? TACTIC_ORDER.length : i;
};

// Heat fill: brand mixed into the card colour. Light mode stays light enough for dark text;
// dark mode ramps brighter and hot cells flip to primary-foreground (near-black).
const HEAT_BG =
  "bg-[color-mix(in_srgb,var(--brand)_calc(var(--heat)*58%),var(--card))] dark:bg-[color-mix(in_srgb,var(--brand)_calc(var(--heat)*82%),var(--card))]";
const HEAT_RAMP =
  "bg-[linear-gradient(90deg,color-mix(in_srgb,var(--brand)_7%,var(--card)),color-mix(in_srgb,var(--brand)_58%,var(--card)))] dark:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--brand)_10%,var(--card)),color-mix(in_srgb,var(--brand)_82%,var(--card)))]";

function HeatLegend({ max }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <span>1</span>
      <span aria-hidden className={cn("h-2 w-24 rounded-full", HEAT_RAMP)} />
      <span>
        {fmtNum(max)} {max === 1 ? "hit" : "hits"}
      </span>
      <span className="sr-only">Darker cells have more hits.</span>
    </div>
  );
}

function TechniqueCell({ t, max, tactic }) {
  const name = t.name || TECHNIQUES[t.id]?.name || t.id;
  const heat = t.count / max;
  const hits = `${fmtNum(t.count)} ${t.count === 1 ? "hit" : "hits"}`;
  const summary = `${t.id} · ${name} · ${tactic} · ${hits}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={`/incidents?technique=${encodeURIComponent(t.id)}`}
            // One link per heatmap cell: never prefetch these.
            prefetch={false}
            aria-label={summary}
            style={t.count ? { "--heat": Math.max(0.12, heat) } : undefined}
            className={cn(
              "relative block min-w-0 rounded-md border px-2 py-1.5 pr-8 text-foreground transition-colors duration-120 hover:border-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
              t.count === 0
                ? "border-border bg-muted text-muted-foreground"
                : cn(HEAT_BG, heat > 0.62 ? "border-transparent dark:text-primary-foreground" : "border-border"),
            )}
          />
        }
      >
        <span translate="no" className="block font-mono text-xs">
          {t.id}
        </span>
        <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{name}</span>
        {t.count > 0 ? (
          <span className="absolute top-1.5 right-2 text-xs font-semibold tabular-nums">
            {fmtNum(t.count)}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent>{summary}</TooltipContent>
    </Tooltip>
  );
}

export default function AttackMatrix() {
  const [range, setRange] = useState("30d");
  const { data, error, loading, reload } = useAsync(() => api.attackMatrix(PROJECT), [range]);
  const tactics = [...(data?.tactics || [])]
    .filter((t) => t.techniques?.length)
    .sort((a, b) => tacticRank(a.tactic) - tacticRank(b.tactic));
  const max = Math.max(1, ...tactics.flatMap((t) => t.techniques.map((x) => x.count)));
  const total = tactics.reduce((n, t) => n + t.techniques.filter((x) => x.count > 0).length, 0);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="ATT&CK matrix"
        purpose="Which techniques attackers actually used against your decoys. Darker cells are hit more often; select a cell to see its incidents."
      />
      <SectionCard
        flush
        title="Technique heatmap"
        detail={
          data ? `${fmtNum(total)} ${total === 1 ? "technique" : "techniques"} observed` : undefined
        }
        action={
          <>
            {tactics.length ? <HeatLegend max={max} /> : null}
            <FilterSelect
              label="Time range"
              value={range}
              onChange={setRange}
              options={[
                { value: "24h", label: "Last 24 h" },
                { value: "7d", label: "Last 7 days" },
                { value: "30d", label: "Last 30 days" },
              ]}
            />
          </>
        }
      >
        {loading && !data ? (
          <TableSkeleton cols={6} />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} what="the ATT&CK matrix" />
        ) : tactics.length === 0 ? (
          <EmptyState icon={Grid3x3} title="No techniques observed yet">
            Detections map each behaviour to MITRE ATT&amp;CK. Cells fill in as attackers touch the
            decoys.
          </EmptyState>
        ) : (
          <ScrollShadow
            label="ATT&CK matrix, scroll horizontally for more tactics"
            className="rounded-b-lg"
          >
            <div className="grid w-max min-w-full auto-cols-[minmax(9rem,1fr)] grid-flow-col gap-2 px-4 pt-1 pb-4">
              {tactics.map((t) => {
                const seen = t.techniques.reduce((n, x) => n + (x.count > 0 ? 1 : 0), 0);
                return (
                  <section key={t.tactic} aria-label={t.tactic} className="flex min-w-0 flex-col gap-1.5">
                    <h3
                      title={`${t.tactic} · ${seen} of ${t.techniques.length} techniques observed`}
                      className="m-0 flex h-8 min-w-0 items-center justify-between gap-2 rounded-md bg-muted px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                    >
                      <span className="min-w-0 truncate">{t.tactic}</span>
                      <span className="shrink-0 tabular-nums">
                        {seen}
                        <span className="sr-only"> observed</span>
                      </span>
                    </h3>
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {[...t.techniques]
                        .sort((a, b) => b.count - a.count || String(a.id).localeCompare(b.id))
                        .map((x, xi) => (
                          <li key={`${x.id}-${xi}`} className="min-w-0">
                            <TechniqueCell t={x} max={max} tactic={t.tactic} />
                          </li>
                        ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </ScrollShadow>
        )}
      </SectionCard>
    </div>
  );
}
