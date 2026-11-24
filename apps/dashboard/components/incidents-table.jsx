"use client";
import Link from "next/link";
import { KillMini } from "@/components/killchain";
import {
  Badge,
  LabelPill,
  RelativeTime,
  SeverityPill,
  StatusPill,
  TechList,
} from "@/components/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { replayBadge } from "@/lib/first-run";
import { cn } from "@/lib/utils";

/*
 * Shared incident list (incident queue, attacker profile). Rows are real <Link>s stretched over
 * the row (no tr onClick); ≥ md a table whose low-priority columns hide first, < md stacked cards.
 */

/** Tags shown after the label in the meta line: at most 2 in total, the rest as "+N". */
function metaTags(i) {
  const tags = [];
  if (i.real_asset_reached) tags.push("Real asset reached");
  if (i.honeytoken_used) tags.push("Honeytoken used");
  return tags;
}

function MetaLine({ i, className }) {
  const replay = replayBadge(i); // "Sample data" / "Test" outranks the other tags
  const tags = metaTags(i);
  const shown = replay ? [] : tags.slice(0, 1); // label + 1 tag = 2 badges max
  const rest = replay ? tags : tags.slice(1);
  return (
    <span className={cn("flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden", className)}>
      <span translate="no" className="shrink-0 font-mono text-xs text-muted-foreground">
        {i.src_ip}
      </span>
      <LabelPill label={i.label} />
      {replay ? (
        <Badge variant="tag" tone="info" title={replay.title}>
          {replay.label}
        </Badge>
      ) : null}
      {shown.map((t) => (
        <Badge key={t} variant="tag" tone="bad">
          {t}
        </Badge>
      ))}
      {rest.length ? (
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          title={rest.join(", ")}
        >
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}

/** Desktop/tablet table (≥ md). Whole row is a real link; low-priority columns hide first. */
export function QueueTable({ incidents }) {
  return (
    <Table inset className="table-auto">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">Severity</TableHead>
          <TableHead scope="col" className="text-right">
            Score
          </TableHead>
          <TableHead scope="col" className="w-full">
            Incident
          </TableHead>
          <TableHead scope="col" className="hidden lg:table-cell">
            Kill chain
          </TableHead>
          <TableHead scope="col" className="hidden xl:table-cell">
            ATT&amp;CK
          </TableHead>
          <TableHead scope="col" className="hidden lg:table-cell">
            Last activity
          </TableHead>
          <TableHead scope="col">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {incidents.map((i) => (
          <TableRow key={i.id} className="relative h-14 has-[a:focus-visible]:bg-muted/50">
            <TableCell>
              <SeverityPill severity={i.severity} />
            </TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">
              {i.score}
            </TableCell>
            <TableCell className="max-w-0">
              <Link
                href={`/incidents/${i.id}`}
                prefetch={false}
                className="block truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:outline-2 focus-visible:after:outline-solid focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                title={i.title}
              >
                <span className="text-muted-foreground tabular-nums">#{i.number}</span> {i.title}
              </Link>
              <MetaLine i={i} className="mt-0.5" />
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              <KillMini stages={i.stages} severity={i.severity} />
            </TableCell>
            <TableCell className="hidden xl:table-cell">
              {i.techniques.length ? (
                // Above the row link so each ID keeps its own tooltip.
                <TechList
                  ids={i.techniques}
                  max={3}
                  link={false}
                  className="relative z-10 flex-nowrap whitespace-nowrap"
                />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
              <RelativeTime iso={i.last_event_at} />
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <StatusPill status={i.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Mobile (< md): stacked cards, one link each. */
export function QueueCards({ incidents }) {
  return (
    <ul className="m-0 list-none divide-y divide-border border-t border-border p-0">
      {incidents.map((i) => (
        <li key={i.id}>
          <Link
            href={`/incidents/${i.id}`}
            prefetch={false}
            className="flex min-w-0 flex-col gap-1.5 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex min-w-0 items-center gap-2">
              <SeverityPill severity={i.severity} />
              <span className="ml-auto text-sm font-medium tabular-nums">{i.score}</span>
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              <span className="text-muted-foreground tabular-nums">#{i.number}</span> {i.title}
            </span>
            <MetaLine i={i} />
            <span className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              <StatusPill status={i.status} />
              <KillMini stages={i.stages} severity={i.severity} />
              <span className="ml-auto whitespace-nowrap">
                <RelativeTime iso={i.last_event_at} />
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Table ≥ md, cards < md. Render inside `<Card flush>`. */
export function IncidentQueue({ incidents }) {
  return (
    <>
      <div className="hidden md:block">
        <QueueTable incidents={incidents} />
      </div>
      <div className="md:hidden">
        <QueueCards incidents={incidents} />
      </div>
    </>
  );
}
