"use client";
import { Download, ScrollText, SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Button,
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
import { csvEscape, downloadBlob, fmtNum } from "@/lib/utils";

// A plain-English sentence for one audit row, so the accountability record reads like
// language, not like raw action ids (IMPR P1).
function humanizeAudit(r) {
  const who = r.actor === "system" ? "A system job" : r.actor;
  const md = r.metadata || {};
  const tgt = r.target || "the project";
  const to = md.to ? ` (now ${md.to})` : "";
  switch (r.action) {
    case "block_ip":
      return `${who} blocked ${tgt}${md.duration_hours ? ` for ${md.duration_hours} h` : ""}.`;
    case "unblock_ip":
      return `${who} unblocked ${tgt}.`;
    case "incident.acknowledge":
      return `${who} acknowledged ${tgt}${to}.`;
    case "incident.resolve":
      return `${who} resolved ${tgt}.`;
    case "incident.false_positive":
      return `${who} marked ${tgt} a false positive.`;
    case "key.create":
      return `${who} created an API key.`;
    case "key.revoke":
      return `${who} revoked an API key.`;
    case "settings.update":
      return `${who} changed project settings${md.field ? ` (${md.field})` : ""}.`;
    default:
      return `${who} ${r.action.replace(/[._]/g, " ")} on ${tgt}.`;
  }
}

// Full timestamp with year and timezone — the audit log is a legal record, so the detail
// view spells the time out even though the table keeps the app's compact stamp.
function preciseStamp(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

/** Export CSV: outline; when there is nothing to export it is disabled with a reason. */
function ExportButton({ count, reason, onExport }) {
  return (
    <Button variant="outline" onClick={onExport} disabledReason={count ? undefined : reason}>
      <Download aria-hidden /> Export CSV
    </Button>
  );
}

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
  const filtered = actor !== "all" || action !== "all" || q !== "";
  const clearFilters = () => {
    setActor("all");
    setAction("all");
    setQ("");
  };

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
    toast(
      `Exported ${fmtNum(shown.length)} audit ${shown.length === 1 ? "entry" : "entries"}`,
      "success",
    );
  };

  const day = Date.now() - 86400e3;
  const last24 = rows.filter((r) => new Date(r.at).getTime() > day).length;
  const blocks = rows.filter((r) => r.action === "block_ip").length;
  const exportReason = !data
    ? "Entries are still loading"
    : rows.length === 0
      ? "Nothing to export: no entries yet"
      : "Nothing to export: no entries match the filters";

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Audit log"
        purpose="Append-only record of every action taken in this project: who did what, to what, and when."
        actions={<ExportButton count={shown.length} reason={exportReason} onExport={exportCsv} />}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile
          label="Entries"
          value={data ? rows.length : "—"}
          hint="Kept for the project retention window"
        />
        <StatTile label="Last 24 h" value={data ? last24 : "—"} hint="Actions taken today" />
        <StatTile label="Blocks" value={data ? blocks : "—"} hint="Source blocks issued" />
        <StatTile
          label="Actors"
          value={data ? actors.length : "—"}
          hint="People and system jobs"
        />
      </div>

      <SectionCard
        title="Entries"
        detail={
          data
            ? filtered
              ? `${fmtNum(shown.length)} of ${fmtNum(rows.length)}`
              : `${fmtNum(rows.length)} total`
            : undefined
        }
        flush
      >
        {rows.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 px-5 pb-3">
            <TextFilter
              value={q}
              onChange={setQ}
              placeholder="Search target or metadata…"
              label="Search target or metadata"
            />
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
            {filtered ? (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null}
        {loading && !data ? (
          <TableSkeleton cols={5} />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} what="the audit log" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No actions recorded yet"
            action={
              <Button variant="outline" render={<Link href="/incidents" />} nativeButton={false}>
                Review incidents
              </Button>
            }
          >
            This log records every block, acknowledgement, key and settings change. It fills in as
            people and system jobs act on incidents.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No entries match these filters"
            action={
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          >
            {q
              ? `Nothing matches “${q}” for the selected actor and action.`
              : "No entries for the selected actor and action."}
          </EmptyState>
        ) : (
          <AuditTable rows={shown} onOpen={setOpen} />
        )}
      </SectionCard>

      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? open.action : ""}>
        {open ? (
          <div className="detail-stack">
            <p className="m-0 text-base font-medium text-foreground">{humanizeAudit(open)}</p>
            <dl className="ds-facts">
              <div>
                <dt>Time</dt>
                <dd className="tabular-nums">{preciseStamp(open.at)}</dd>
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
                <dd translate="no" className="font-mono">
                  {open.ip || "—"}
                </dd>
              </div>
            </dl>
            <div className="ds-section">
              <h3>Metadata</h3>
              <CodeBlock label="Metadata">{JSON.stringify(open.metadata, null, 2)}</CodeBlock>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
