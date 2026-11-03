"use client";
import { Grid3x3 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  TableSkeleton,
  techTitle,
} from "@/components/ui";
import { FilterSelect, SectionCard } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useAsync } from "@/lib/hooks";
import { TECHNIQUES } from "@/lib/mock";

export default function AttackMatrix() {
  const [range, setRange] = useState("30d");
  const { data, error, loading, reload } = useAsync(() => api.attackMatrix(PROJECT), [range]);
  const tactics = data?.tactics || [];
  const max = Math.max(1, ...tactics.flatMap((t) => t.techniques.map((x) => x.count)));
  const total = tactics.reduce((n, t) => n + t.techniques.filter((x) => x.count > 0).length, 0);

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="MONITOR / COVERAGE"
        title="ATT&CK matrix"
        purpose="Which techniques attackers actually used against your decoys. Darker cells are hit more often; click a cell to see the incidents."
      />
      <SectionCard
        flush
        title="Technique heatmap"
        detail={`${total} techniques observed`}
        action={
          <div className="row" style={{ gap: 14 }}>
            <div className="heat-legend">
              <span>fewer hits</span>
              <span className="ramp" />
              <span>more hits</span>
            </div>
            <FilterSelect
              label=""
              value={range}
              onChange={setRange}
              options={[
                { value: "24h", label: "Last 24 h" },
                { value: "7d", label: "Last 7 days" },
                { value: "30d", label: "Last 30 days" },
              ]}
            />
          </div>
        }
      >
        {loading && !data ? (
          <TableSkeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : tactics.length === 0 ? (
          <EmptyState icon={Grid3x3} title="No techniques mapped yet">
            Detections map each behaviour to MITRE ATT&amp;CK. Cells fill in as attackers touch the
            decoys.
          </EmptyState>
        ) : (
          <div className="matrix" role="table" aria-label="ATT&CK matrix">
            {tactics.map((t) => (
              <div className="matrix-col" key={t.tactic} role="rowgroup">
                <div className="matrix-tactic">
                  <span>{t.tactic}</span>
                  <span>{t.techniques.reduce((n, x) => n + (x.count > 0 ? 1 : 0), 0)}</span>
                </div>
                {t.techniques.length === 0 ? (
                  <div className="cell is-empty" style={{ textAlign: "center" }}>
                    —
                  </div>
                ) : (
                  [...t.techniques]
                    .sort((a, b) => b.count - a.count)
                    .map((x, xi) => {
                      const heat = x.count / max;
                      return (
                        <Link
                          key={`${x.id}-${xi}`}
                          href={`/incidents?technique=${encodeURIComponent(x.id)}`}
                          // One link per heatmap cell: never prefetch these.
                          prefetch={false}
                          className={`cell${x.count === 0 ? " is-empty" : ""}${heat > 0.45 ? " is-hot" : ""}`}
                          style={{ "--heat": x.count ? Math.max(0.12, heat) : 0 }}
                          title={`${techTitle(x.id)}\n${x.count} hits`}
                          role="cell"
                        >
                          <span className="cell-id">{x.id}</span>
                          {x.name || TECHNIQUES[x.id]?.name}
                          {x.count > 0 ? <span className="cell-count">{x.count}</span> : null}
                        </Link>
                      );
                    })
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
      <div className="row-wrap" style={{ gap: 8, fontSize: 12 }}>
        <Pill tone="brand">Tip</Pill>
        <span className="dim">
          Hover any cell for the technique description. IDs are the same ones shown as chips on each
          incident.
        </span>
      </div>
    </div>
  );
}
