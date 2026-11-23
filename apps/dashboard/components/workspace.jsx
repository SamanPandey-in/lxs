"use client";
import { ShieldBan } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { activeProjectName, api, PROJECT } from "@/lib/core";
import { EVENT_LABEL, eventTone } from "@/lib/labels";
import { toast } from "@/lib/toast";
import { clock, cn, stamp } from "@/lib/utils";
import { IncidentQueue } from "./incidents-table";
import { Badge, Card, Field, Modal, RelativeTime, SearchInput, Select } from "./ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

export { stamp, clock };
export { duration } from "@/lib/utils";

export function SectionCard({ title, detail, action, children, flush }) {
  return (
    <Card title={title} sub={detail} right={action} flush={flush}>
      {children}
    </Card>
  );
}

// RelativeTime lives in ui.jsx (shared with components/incidents-table); re-exported here.
export { RelativeTime };

export function RouteLink({ href, children, className = "table-link" }) {
  return (
    // No prefetch: a table renders one of these per row.
    <Link href={href} className={className} prefetch={false}>
      {children}
    </Link>
  );
}

// Shared filter controls: thin adapters over the design-system components (agents/ui/components.md).
export function FilterSelect({ label, value, onChange, options }) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
      options={options}
      aria-label={label}
      className="w-auto min-w-40"
    />
  );
}

export function TextFilter({ value, onChange, placeholder = "Search…", label = "Search" }) {
  return (
    <SearchInput
      value={value}
      onValueChange={onChange}
      placeholder={placeholder}
      aria-label={label}
      className="min-w-0 flex-1 sm:max-w-sm"
    />
  );
}

/** One-line, escaped description of an event (attacker text is data, rendered as text only). */
export function describeEvent(e) {
  const f = e.fields || {};
  switch (e.event_type) {
    case "http.request":
      return `${f.method || "GET"} ${f.url || e.dst_service}${f.status_code ? ` → ${f.status_code}` : ""}${e.count > 1 ? ` ×${e.count}` : ""}`;
    case "auth.attempt":
      return `${f.username || "?"} / ${f.password_masked || "•••"} ${e.outcome === "success" ? "✔ accepted" : "✘ rejected"}${e.count > 1 ? ` ×${e.count}` : ""}`;
    case "command.exec":
    case "file.download":
    case "honeytoken.read":
    case "db.command":
      return f.command ? `$ ${f.command}` : e.dst_service;
    case "honeytoken.use":
      return `${f.authorization || f.token || "token"} → ${f.method || "GET"} ${f.url || ""} ${f.status_code || ""}`;
    case "asset.access":
      return `${f.method || "GET"} ${f.url || e.dst_service} → ${f.status_code || ""}${f.asset ? ` · ${f.asset}` : ""}`;
    case "asset.blocked":
      return `${f.method || ""} ${f.url || e.dst_service} → ${f.status_code || 403} (${f.reason || "blocked"})`;
    case "connection.open":
      return f.client_banner ? `Client ${f.client_banner}` : e.dst_service;
    default:
      return f.note || f.command || e.dst_service;
  }
}

// Event tone (lib/labels eventTone) → token colour utilities from @theme inline (globals.css).
const EVENT_DOT = {
  bad: "bg-bad",
  drift: "bg-warn",
  rejected: "bg-rejected",
  ok: "bg-ok",
  halted: "bg-halted",
};

/** 8 px decorative dot coloured by the event's tone. Pass `e` (an event) or a `tone` directly. */
export function EventDot({ e, tone, className }) {
  const t = tone ?? (e ? eventTone(e) : "halted");
  return (
    <span
      aria-hidden
      data-tone={t}
      className={cn("size-2 shrink-0 rounded-full", EVENT_DOT[t] ?? EVENT_DOT.halted, className)}
    />
  );
}

/* ───────── Incidents table ───────── */
/**
 * Incident list with real row links (table ≥ md, cards < md). Same component as the incident
 * queue (components/incidents-table.jsx). Render inside `<Card flush>`.
 */
// biome-ignore lint/correctness/noUnusedFunctionParameters: emptyHint kept for API compatibility
export function IncidentsTable({ incidents, emptyHint }) {
  if (!incidents?.length) return null;
  return <IncidentQueue incidents={incidents} />;
}

/* ───────── Block / unblock confirm modals ───────── */

/** Name of the active project for confirm copy; "this project" until (or unless) it resolves. */
function useProjectName(active) {
  const [name, setName] = useState(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    activeProjectName().then((n) => {
      if (live) setName(n);
    });
    return () => {
      live = false;
    };
  }, [active]);
  return name;
}

const DURATIONS = [
  { value: "1", label: "1 hour" },
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
];
const durationLabel = (h) => DURATIONS.find((d) => d.value === h)?.label ?? `${h} h`;

export function BlockModal({ open, onClose, ip, incident, onDone }) {
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const project = useProjectName(open);
  const submit = async () => {
    setBusy(true);
    try {
      if (incident) {
        await api.action(incident.id, {
          type: "block_ip",
          params: { ip, duration_hours: Number(hours) },
          reason: `Block from incident #${incident.number}`,
        });
      } else {
        await api.addBlock(PROJECT, {
          ip,
          duration_hours: Number(hours),
          reason: "Manual block from attacker profile",
        });
      }
      toast(
        `Block applied. ${ip} will be refused on its next request`,
        "success",
        `Blocked for ${durationLabel(hours)} · written to the audit log`,
      );
      onDone?.();
      onClose();
    } catch (err) {
      toast("Could not block source", "error", err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Block ${ip}?`}
      actions={[
        {
          label: `Block for ${durationLabel(hours)}`,
          tone: "danger",
          onClick: submit,
          busy,
        },
      ]}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <p className="m-0">
          <strong className="font-medium text-foreground [overflow-wrap:anywhere]">{ip}</strong>{" "}
          will be added to the project blocklist and pushed to every sensor and the app middleware
          in{" "}
          {project ? (
            <strong className="font-medium text-foreground">{project}</strong>
          ) : (
            "this project"
          )}
          . Its next request will be refused. One row is written to the audit log.
        </p>
        <Field label="Duration" htmlFor="blk-dur">
          <Select
            id="blk-dur"
            name="duration"
            value={hours}
            onValueChange={setHours}
            options={DURATIONS}
            className="w-full"
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Destructive confirm: lifting a block lets the source reach the decoys and the app again. */
export function UnblockModal({ open, onClose, ip, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const project = useProjectName(open);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Unblock ${ip}?`}
      actions={[
        {
          label: "Unblock source",
          tone: "danger",
          busy,
          onClick: async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          },
        },
      ]}
    >
      <p className="m-0">
        Traffic from{" "}
        <strong className="font-medium text-foreground [overflow-wrap:anywhere]">{ip}</strong> will
        reach the decoys and the app in{" "}
        {project ? <strong className="font-medium text-foreground">{project}</strong> : "this project"}{" "}
        again from the next policy poll. The decoys keep scoring it. One row is written to the
        audit log.
      </p>
    </Modal>
  );
}

/* ───────── Audit table ───────── */

// Audit actions → semantic tag tones. Blocks are a destructive *action* (tag "bad"), never a
// severity fill; incident workflow is info; unblock is ok; everything else neutral.
function actionTone(action = "") {
  if (action === "unblock_ip" || action.includes("unblock")) return "ok";
  if (action.includes("block") || action.includes("revoke") || action.includes("delete"))
    return "bad";
  if (action.startsWith("incident")) return "info";
  return "neutral";
}

/**
 * Audit log rows. The time cell holds a real <button> stretched over the row (after:inset-0),
 * so the whole row opens the entry via `onOpen(row)` with a visible keyboard focus ring.
 */
export function AuditTable({ rows, onOpen }) {
  return (
    <Table inset>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">Time</TableHead>
          <TableHead scope="col">Actor</TableHead>
          <TableHead scope="col">Action</TableHead>
          <TableHead scope="col">Target</TableHead>
          <TableHead scope="col">Metadata</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const meta = JSON.stringify(r.metadata ?? {});
          return (
            <TableRow key={r.id} className="relative h-11 has-[button:focus-visible]:bg-muted/50">
              <TableCell className="whitespace-nowrap font-mono tabular-nums">
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  aria-label={`Open audit entry: ${r.action} on ${r.target || "—"} at ${stamp(r.at)}`}
                  className="cursor-pointer text-left outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:outline-2 focus-visible:after:outline-solid focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                >
                  {stamp(r.at)}
                </button>
              </TableCell>
              <TableCell>
                {r.actor === "system" ? (
                  <Badge variant="tag" tone="neutral">
                    System
                  </Badge>
                ) : (
                  <span className="[overflow-wrap:anywhere]">{r.actor}</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="tag" tone={actionTone(r.action)} className="font-mono">
                  {r.action}
                </Badge>
              </TableCell>
              <TableCell className="[overflow-wrap:anywhere]">{r.target || "—"}</TableCell>
              <TableCell className="max-w-0 w-full">
                <span
                  className="block truncate font-mono text-xs text-muted-foreground"
                  title={meta}
                  translate="no"
                >
                  {meta}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export { EVENT_LABEL, ShieldBan };
