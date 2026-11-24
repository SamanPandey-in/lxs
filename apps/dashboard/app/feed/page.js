"use client";
import { ChevronRight, Pause, Play, Radio, SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  SeverityPill,
  StatusDot,
  TableSkeleton,
} from "@/components/ui";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeEvent, EventDot, FilterSelect, TextFilter } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useNow } from "@/lib/hooks";
import { EVENT_LABEL } from "@/lib/labels";
import { storeActions, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { clock, cn, fmtNum } from "@/lib/utils";

const PAGE = 120;
const NOT_YET =
  "A single decoy touch stays below the incident threshold, so no incident has been raised for it yet.";

export default function FeedPage() {
  const st = useStore();
  const now = useNow(4000);
  const [decoy, setDecoy] = useState("all");
  const [type, setType] = useState("all");
  const [q, setQ] = useState("");
  const [hideSim, setHideSim] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  // Decoy keys repeat across sensors; one option per key.
  const decoyOpts = useMemo(() => {
    const seen = new Map();
    for (const d of st.decoys) if (!seen.has(d.key)) seen.set(d.key, d.name || d.key);
    return [
      { value: "all", label: "All decoys" },
      ...[...seen].map(([value, label]) => ({ value, label })),
      { value: "app", label: "Real app (SDK)" },
    ];
  }, [st.decoys]);
  const typeOpts = [
    { value: "all", label: "All event types" },
    ...Object.entries(EVENT_LABEL).map(([k, v]) => ({ value: k, label: v })),
  ];

  const filtered = decoy !== "all" || type !== "all" || q.trim() !== "" || hideSim;
  const clearFilters = () => {
    setDecoy("all");
    setType("all");
    setQ("");
    setHideSim(false);
  };

  const rows = useMemo(
    () =>
      st.events.filter((e) => {
        if (decoy !== "all" && (decoy === "app" ? e.decoy_id : e.decoy_id !== decoy)) return false;
        if (type !== "all" && e.event_type !== type) return false;
        if (hideSim && e.simulated) return false;
        if (q && !e.src_ip.includes(q.trim())) return false;
        return true;
      }),
    [st.events, decoy, type, q, hideSim],
  );
  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;

  const replay = async () => {
    try {
      await api.replay(PROJECT, { scenario: "ps-use-case" });
      toast("Simulation started", "success", "Replaying the SSH to payments scenario.");
    } catch (e) {
      toast("Couldn't start the simulation", "error", e.message);
    }
  };

  const live = st.paused
    ? { tone: "neutral", label: "Paused" }
    : st.conn === "live"
      ? { tone: "ok", label: "Live" }
      : st.conn === "demo"
        ? { tone: "info", label: "Simulated" }
        : { tone: "warn", label: "Reconnecting…" };

  const count = !st.bootstrapped
    ? undefined
    : filtered
      ? `${fmtNum(rows.length)} of ${fmtNum(st.events.length)}`
      : `${fmtNum(st.events.length)} loaded`;

  return (
    <div className="ds-page gap-6">
      <PageHeader
        title="Live feed"
        purpose="Every decoy touch as it happens. Select a row to open the incident it belongs to."
      />

      <Card
        title="Decoy events"
        sub={count}
        right={
          <>
            <span aria-live="polite" className="flex items-center gap-2">
              <StatusDot tone={live.tone}>{live.label}</StatusDot>
              {st.liveCount ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {fmtNum(st.liveCount)} new since you opened this tab
                </span>
              ) : null}
            </span>
            <Button variant="outline" size="sm" onClick={() => storeActions.setPaused(!st.paused)}>
              {st.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {st.paused ? "Resume" : "Pause"}
            </Button>
          </>
        }
        flush
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-5 pb-3">
          <TextFilter
            value={q}
            onChange={setQ}
            placeholder="Filter by source IP…"
            label="Source IP"
          />
          <FilterSelect label="Decoy" value={decoy} onChange={setDecoy} options={decoyOpts} />
          <FilterSelect label="Event type" value={type} onChange={setType} options={typeOpts} />
          <Checkbox
            label="Hide simulated"
            checked={hideSim}
            onCheckedChange={setHideSim}
            labelClassName="px-1"
          />
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>

        {!st.bootstrapped ? (
          <TableSkeleton cols={6} />
        ) : !st.loaded && st.error ? (
          <ErrorState error={st.error} onRetry={storeActions.refresh} what="events" />
        ) : st.events.length === 0 ? (
          <EmptyState
            icon={Radio}
            title="No decoy events yet"
            action={
              <Button variant="outline" onClick={replay}>
                <Play aria-hidden /> Run simulation
              </Button>
            }
          >
            Events appear here the moment anything touches a decoy.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No events match these filters"
            action={
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          >
            {q.trim()
              ? `Nothing from a source matching “${q.trim()}”.`
              : "Loosen the filters, or wait for the next decoy touch."}
          </EmptyState>
        ) : (
          <>
            {/* ≥ 768: table */}
            <Table className="hidden table-fixed md:table">
              <TableHeader>
                <TableRow className="border-t hover:bg-transparent">
                  <TableHead scope="col" className="w-24 pl-5">
                    Time
                  </TableHead>
                  <TableHead scope="col" className="w-36">
                    Source
                  </TableHead>
                  <TableHead scope="col" className="hidden w-40 lg:table-cell">
                    Decoy
                  </TableHead>
                  <TableHead scope="col" className="w-44">
                    Event
                  </TableHead>
                  <TableHead scope="col">Detail</TableHead>
                  <TableHead scope="col" className="w-36 pr-5">
                    Incident
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((e) => {
                  const inc = e.incident_id ? st.incidents.get(e.incident_id) : null;
                  const detail = describeEvent(e);
                  return (
                    <TableRow
                      key={e.id}
                      className={cn(
                        "relative h-11",
                        inc &&
                          "cursor-pointer focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring focus-within:outline-solid",
                        isNew(e, now) &&
                          "bg-primary/5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
                      )}
                    >
                      <TableCell className="pl-5 font-mono text-muted-foreground tabular-nums whitespace-nowrap">
                        {clock(e.occurred_at)}
                      </TableCell>
                      <TableCell className="truncate font-mono" translate="no">
                        {e.src_ip}
                      </TableCell>
                      <TableCell className="hidden truncate lg:table-cell">
                        <DecoyCell e={e} />
                      </TableCell>
                      <TableCell className="truncate">
                        <EventLabel e={e} />
                      </TableCell>
                      <TableCell
                        className="truncate font-mono text-muted-foreground"
                        title={detail}
                        translate="no"
                      >
                        {detail}
                      </TableCell>
                      <TableCell className="pr-5">
                        <IncidentCell inc={inc} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {/* < 768: stacked rows */}
            <ul className="m-0 list-none border-t border-border p-0 md:hidden">
              {shown.map((e) => {
                const inc = e.incident_id ? st.incidents.get(e.incident_id) : null;
                const body = <MobileRow e={e} inc={inc} />;
                return (
                  <li
                    key={e.id}
                    className={cn(
                      "border-b border-border last:border-b-0",
                      isNew(e, now) && "bg-primary/5",
                    )}
                  >
                    {inc ? (
                      <Link
                        href={`/incidents/${inc.id}`}
                        prefetch={false}
                        aria-label={`Incident #${inc.number}: ${inc.title}`}
                        className="block text-inherit no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid"
                      >
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>

            {hidden > 0 ? (
              <div className="flex justify-center border-t border-border px-5 py-3">
                <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
                  Show {fmtNum(Math.min(PAGE, hidden))} more · {fmtNum(hidden)} older{" "}
                  {hidden === 1 ? "event" : "events"} hidden
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

const isNew = (e, now) => now - new Date(e.received_at).getTime() < 4500;

function EventLabel({ e }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <EventDot e={e} />
      <span className="truncate">{EVENT_LABEL[e.event_type] || e.event_type}</span>
    </span>
  );
}

function DecoyCell({ e }) {
  return e.decoy_id ? (
    <span className="font-mono" translate="no" title={e.decoy_id}>
      {e.decoy_id}
    </span>
  ) : (
    <Badge variant="tag" tone="bad">
      Real app
    </Badge>
  );
}

function IncidentCell({ inc }) {
  if (!inc)
    return (
      <span className="text-sm text-muted-foreground" title={NOT_YET}>
        —<span className="sr-only">Not an incident yet</span>
      </span>
    );
  return (
    <Link
      href={`/incidents/${inc.id}`}
      prefetch={false}
      aria-label={`Incident #${inc.number}: ${inc.title}`}
      className="inline-flex items-center gap-2 text-inherit no-underline outline-none after:absolute after:inset-0"
    >
      <SeverityPill severity={inc.severity} />
      <span className="text-muted-foreground tabular-nums">#{inc.number}</span>
      <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
    </Link>
  );
}

function MobileRow({ e, inc }) {
  const detail = describeEvent(e);
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
          {clock(e.occurred_at)}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          <EventLabel e={e} />
        </span>
        {inc ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <SeverityPill severity={inc.severity} />
            <span className="text-xs text-muted-foreground tabular-nums">#{inc.number}</span>
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono text-foreground" translate="no">
          {e.src_ip}
        </span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">
          <DecoyCell e={e} />
        </span>
      </div>
      <div
        className="truncate font-mono text-xs text-muted-foreground"
        title={detail}
        translate="no"
      >
        {detail}
      </div>
    </div>
  );
}
