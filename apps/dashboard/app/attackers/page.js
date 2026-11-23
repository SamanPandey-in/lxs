"use client";
import { Bot, Coins, HelpCircle, SearchX, User, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LabelPill,
  PageHeader,
  TableSkeleton,
} from "@/components/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilterSelect, RelativeTime, TextFilter } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { fmtNum } from "@/lib/utils";

const LABEL_OPTS = [
  { value: "all", label: "All labels" },
  { value: "targeted", label: "Targeted" },
  { value: "opportunistic", label: "Opportunistic" },
  { value: "noise", label: "Noise" },
];

export default function AttackersPage() {
  const { data, error, loading, reload } = usePolling(() => api.attackers(PROJECT), 7000, []);
  const [label, setLabel] = useState("all");
  const [q, setQ] = useState("");
  const filtered = label !== "all" || q.trim() !== "";
  const clearFilters = () => {
    setLabel("all");
    setQ("");
  };
  const rows = useMemo(
    () =>
      (data || [])
        .filter((a) => (label === "all" || a.label === label) && (!q || a.ip.includes(q.trim())))
        .sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at)),
    [data, label, q],
  );

  return (
    <div className="ds-page gap-6">
      <PageHeader
        title="Attackers"
        purpose="One profile per source: everything it touched, how it types, and what it tried."
      />
      <Card
        title="Sources seen"
        sub={data ? (filtered ? `${fmtNum(rows.length)} of ${fmtNum(data.length)}` : fmtNum(data.length)) : undefined}
        flush
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-5 pb-3">
          <TextFilter value={q} onChange={setQ} placeholder="Filter by IP…" label="Source IP" />
          <FilterSelect label="Label" value={label} onChange={setLabel} options={LABEL_OPTS} />
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
        {loading && !data ? (
          <TableSkeleton cols={6} />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} what="attackers" />
        ) : !data?.length ? (
          <EmptyState icon={Users} title="No attackers yet">
            Sources appear here the first time they touch a decoy.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No attackers match these filters"
            action={
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          >
            {q.trim() ? `No source matches “${q.trim()}”.` : "Try another label."}
          </EmptyState>
        ) : (
          <>
            <Table className="hidden md:table">
              <TableHeader>
                <TableRow className="border-t hover:bg-transparent">
                  <TableHead scope="col" className="pl-5">
                    Source
                  </TableHead>
                  <TableHead scope="col">Label</TableHead>
                  <TableHead scope="col">Cadence</TableHead>
                  <TableHead scope="col" className="text-right">
                    Events
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Sessions
                  </TableHead>
                  <TableHead scope="col" className="hidden lg:table-cell">
                    Decoys touched
                  </TableHead>
                  <TableHead scope="col">Real assets</TableHead>
                  <TableHead scope="col" className="pr-5">
                    Last seen
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow
                    key={a.id}
                    className="relative h-11 cursor-pointer focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring focus-within:outline-solid"
                  >
                    <TableCell className="pl-5">
                      <Link
                        href={`/attackers/${a.id}`}
                        prefetch={false}
                        className="font-mono font-medium text-foreground no-underline outline-none after:absolute after:inset-0 hover:underline"
                        translate="no"
                      >
                        {a.ip}
                      </Link>
                      {a.fingerprints?.country ? (
                        <span className="block text-xs text-muted-foreground">
                          {a.fingerprints.country}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <LabelPill label={a.label} />
                    </TableCell>
                    <TableCell>
                      <CadenceTag cadence={a.cadence} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(a.event_count)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtNum(a.session_count)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <DecoyTags decoys={a.decoys_touched} />
                    </TableCell>
                    <TableCell>
                      <RealAssets assets={a.real_assets_touched} />
                    </TableCell>
                    <TableCell className="pr-5 whitespace-nowrap text-muted-foreground">
                      <RelativeTime iso={a.last_seen_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* < 768: stacked rows */}
            <ul className="m-0 list-none border-t border-border p-0 md:hidden">
              {rows.map((a) => (
                <li key={a.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={`/attackers/${a.id}`}
                    prefetch={false}
                    className="flex min-w-0 flex-col gap-1.5 px-4 py-3 text-inherit no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground" translate="no">
                        {a.ip}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <RelativeTime iso={a.last_seen_at} />
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <LabelPill label={a.label} />
                      <CadenceTag cadence={a.cadence} />
                      <RealAssets assets={a.real_assets_touched} hideEmpty />
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {fmtNum(a.event_count)} events · {fmtNum(a.session_count)} sessions
                      {a.decoys_touched?.length
                        ? ` · ${a.decoys_touched.length} ${a.decoys_touched.length === 1 ? "decoy" : "decoys"}`
                        : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

const CADENCE = {
  human: { icon: User, label: "Human" },
  bot: { icon: Bot, label: "Bot" },
};
/** Cadence is a neutral tag: the label column already carries the meaning colour. */
function CadenceTag({ cadence }) {
  const m = CADENCE[cadence] ?? { icon: HelpCircle, label: "Unknown" };
  const Icon = m.icon;
  return (
    <Badge variant="tag" tone="neutral">
      <Icon aria-hidden />
      {m.label}
    </Badge>
  );
}

function DecoyTags({ decoys = [], max = 2 }) {
  if (!decoys.length) return <span className="text-muted-foreground">—</span>;
  const rest = decoys.length - max;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={decoys.join(", ")}>
      {decoys.slice(0, max).map((d) => (
        <Badge key={d} variant="tag" tone="neutral" className="font-mono" translate="no">
          {d}
        </Badge>
      ))}
      {rest > 0 ? <span className="text-xs text-muted-foreground tabular-nums">+{rest}</span> : null}
    </span>
  );
}

function RealAssets({ assets, hideEmpty = false }) {
  if (!assets?.length) return hideEmpty ? null : <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="tag" tone="bad" title={assets.join(", ")}>
      <Coins aria-hidden />
      {assets.length === 1 ? assets[0] : `${assets.length} assets`}
    </Badge>
  );
}
