"use client";
import { Download, ScrollText } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CodeBlock,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  StatTile,
  TableSkeleton,
} from "@/components/ui";
import { AuditTable, FilterSelect, SectionCard, TextFilter } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { csvEscape, downloadBlob, stamp } from "@/lib/utils";

export default function AuditPage() {
  const { data, error, loading, reload } = usePolling(() => api.audit(PROJECT), 6000, []);
  const [actor, setActor] = useState("all");
  const [action, setAction] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);

  const rows = data || [];
  const actors = [...new Set(rows.map((r) => r.actor))];
  const actions = [...new Set(rows.map((r) => r.action))];
  const shown = useMemo(
    () =>
      rows.filter(
        (r) =>
          (actor === "all" || r.actor === actor) &&
          (action === "all" || r.action === action) &&
          (!q ||
            `${r.target} ${JSON.stringify(r.metadata)}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [rows, actor, action, q],
  );

  const exportCsv = () => {
    const lines = [
      "time,actor,action,target,metadata,ip",
      ...shown.map((r) =>
        [r.at, r.actor, r.action, r.target, JSON.stringify(r.metadata), r.ip]
          .map(csvEscape)
          .join(","),
      ),
    ];
    downloadBlob("lxs-audit.csv", lines.join("\n"), "text/csv");
    toast(`Exported ${shown.length} audit rows`, "success");
  };

  const day = Date.now() - 86400e3;
  const last24 = rows.filter((r) => new Date(r.at).getTime() > day).length;

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="TRUST / ACCOUNTABILITY"
        title="Audit log"
        purpose="Append-only record of every action taken in this project: who did what, to what, and when."
        actions={
          <button type="button" className="btn" onClick={exportCsv} disabled={!shown.length}>
            <Download /> Export CSV
          </button>
        }
      />

      <div className="ds-tile-grid">
        <StatTile
          label="Entries"
          value={rows.length}
          hint="Retained for the project retention window"
          tone="healed"
        />
        <StatTile label="Last 24 h" value={last24} hint="Actions taken today" tone="cache" />
        <StatTile
          label="Blocks"
          value={rows.filter((r) => r.action === "block_ip").length}
          hint="Source blocks issued"
          tone="bad"
        />
        <StatTile
          label="Actors"
          value={actors.length}
          hint="People and system jobs"
          tone="halted"
        />
      </div>

      <SectionCard title="Entries" detail={`${shown.length} shown`} flush>
        <div className="ds-filter-bar">
          <FilterSelect
            label="Actor"
            value={actor}
            onChange={setActor}
            options={[
              { value: "all", label: "All actors" },
              ...actors.map((a) => ({ value: a, label: a })),
            ]}
          />
          <FilterSelect
            label="Action"
            value={action}
            onChange={setAction}
            options={[
              { value: "all", label: "All actions" },
              ...actions.map((a) => ({ value: a, label: a })),
            ]}
          />
          <TextFilter
            value={q}
            onChange={setQ}
            placeholder="Search target or metadata…"
            label="Search"
          />
        </div>
        {loading && !data ? (
          <TableSkeleton />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : shown.length === 0 ? (
          <EmptyState icon={ScrollText} title="No audit entries">
            Blocks, acknowledgements and settings changes will be recorded here.
          </EmptyState>
        ) : (
          <AuditTable rows={shown} onOpen={setOpen} />
        )}
      </SectionCard>

      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? open.action : ""}>
        {open ? (
          <div className="detail-stack">
            <dl className="ds-facts">
              <div>
                <dt>Time</dt>
                <dd>{stamp(open.at)}</dd>
              </div>
              <div>
                <dt>Actor</dt>
                <dd>{open.actor}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{open.target}</dd>
              </div>
              <div>
                <dt>Source IP</dt>
                <dd className="mono">{open.ip || "—"}</dd>
              </div>
            </dl>
            <div className="ds-section">
              <h3>Metadata</h3>
              <CodeBlock>{JSON.stringify(open.metadata, null, 2)}</CodeBlock>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
