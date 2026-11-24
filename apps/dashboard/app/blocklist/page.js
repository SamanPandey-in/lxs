"use client";
import { Ban, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast as sonner } from "sonner";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Select,
  StatusDot,
  Table,
  TableSkeleton,
  THead,
} from "@/components/ui";
import { Input } from "@/components/ui/input";
import { RelativeTime, SectionCard } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { fmtNum, stamp } from "@/lib/utils";

const DURATIONS = [
  { value: "1", label: "1 hour" },
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
];
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/;

const sensors = (b) => (b.total_sensors != null ? ` ${b.applied_sensors}/${b.total_sensors}` : "");

function BlockState({ b }) {
  if (b.status === "applied") return <StatusDot tone="ok">Applied{sensors(b)}</StatusDot>;
  if (b.status === "pending") return <StatusDot tone="warn">Pending{sensors(b)}</StatusDot>;
  return <StatusDot tone="neutral">Expired</StatusDot>;
}

function BlockRow({ b, onUnblock }) {
  const expired = b.status === "expired";
  return (
    <tr>
      <td translate="no" className="font-mono font-medium whitespace-nowrap text-foreground">
        {b.ip}
      </td>
      <td>
        <div className="max-w-72 truncate text-foreground" title={b.reason}>
          {b.reason || <span className="text-muted-foreground">—</span>}
        </div>
      </td>
      <td>
        {b.incident_id ? (
          <Link
            prefetch={false}
            href={`/incidents/${b.incident_id}`}
            className="rounded-sm font-medium text-link tabular-nums hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {b.incident_number ? `#${b.incident_number}` : "View incident"}
          </Link>
        ) : (
          <span className="text-muted-foreground">Manual</span>
        )}
      </td>
      <td>
        <span className="block">{b.created_by}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          <RelativeTime iso={b.created_at} />
        </span>
      </td>
      <td className="whitespace-nowrap tabular-nums">
        {expired ? (
          <span className="text-muted-foreground">
            Expired <RelativeTime iso={b.expires_at} />
          </span>
        ) : (
          <>
            <span className="block">
              <RelativeTime iso={b.expires_at} />
            </span>
            <span className="block text-xs text-muted-foreground">{stamp(b.expires_at)}</span>
          </>
        )}
      </td>
      <td className="whitespace-nowrap">
        <BlockState b={b} />
      </td>
      <td
        className="num text-right tabular-nums"
        title="Requests from this source the sensors and app middleware have refused since the block was applied."
      >
        {b.refused_count != null ? (
          <>
            <span
              className={
                b.refused_count
                  ? "block font-medium text-foreground"
                  : "block text-muted-foreground"
              }
            >
              {fmtNum(b.refused_count)}
            </span>
            {b.last_refused_at && !expired ? (
              <span className="block text-xs text-muted-foreground">
                last <RelativeTime iso={b.last_refused_at} />
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="text-right">
        {!expired ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onUnblock(b)}
            aria-label={`Unblock ${b.ip}…`}
          >
            Unblock…
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

const COLS = (expiryLabel) => [
  "Source",
  "Reason",
  "Incident",
  "Created by",
  expiryLabel,
  "Sensors",
  { label: "Refused", num: true },
  "",
];

export default function BlocklistPage() {
  const { data, error, loading, reload } = usePolling(() => api.blocklist(PROJECT), 4000, []);
  const [target, setTarget] = useState(null);
  const [unblocking, setUnblocking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [ip, setIp] = useState("");
  const [ipTouched, setIpTouched] = useState(false);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const validIp = IP_RE.test(ip.trim());

  const active = (data || []).filter((b) => b.status !== "expired");
  const expired = (data || []).filter((b) => b.status === "expired");
  const refused = active.reduce((n, b) => n + (b.refused_count || 0), 0);
  const hasRows = active.length > 0;

  const openAdd = () => {
    setIpTouched(false);
    setAdding(true);
  };

  const add = async () => {
    if (!validIp) {
      setIpTouched(true);
      document.getElementById("b-ip")?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.addBlock(PROJECT, {
        ip: ip.trim(),
        reason: reason.trim() || "Manual block",
        duration_hours: Number(hours),
      });
      const dur = DURATIONS.find((d) => d.value === hours)?.label ?? `${hours} h`;
      toast(
        `Blocked ${ip.trim()} for ${dur}`,
        "success",
        "Pushed to sensors on the next policy poll. Logged to audit.",
      );
      setAdding(false);
      setIp("");
      setReason("");
      reload();
    } catch (e) {
      toast("Couldn't add the block", "error", e.message);
    } finally {
      setBusy(false);
    }
  };

  const unblock = async () => {
    const b = target;
    setUnblocking(true);
    try {
      await api.unblock(PROJECT, b.id);
      setTarget(null);
      reload();
      const left = b.expires_at ? Math.ceil((new Date(b.expires_at) - Date.now()) / 3600e3) : 24;
      sonner.success(`Unblocked ${b.ip}`, {
        description: "Logged to audit.",
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await api.addBlock(PROJECT, {
                ip: b.ip,
                reason: b.reason || "Manual block",
                duration_hours: Math.max(1, left),
              });
              toast(`Blocked ${b.ip} again`, "success", "Logged to audit.");
              reload();
            } catch (e) {
              toast(`Couldn't block ${b.ip} again`, "error", e.message);
            }
          },
        },
      });
    } catch (e) {
      toast(`Couldn't unblock ${b.ip}`, "error", e.message);
    } finally {
      setUnblocking(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Blocklist"
        purpose="Sources currently refused by every sensor and the app middleware. Each change bumps the project policy version and is written to the audit log."
        actions={
          // The empty state carries the primary when nothing is blocked (B1).
          hasRows ? (
            <Button onClick={openAdd}>
              <Plus aria-hidden /> Add block
            </Button>
          ) : null
        }
      />

      <SectionCard
        title="Active blocks"
        detail={
          data
            ? hasRows
              ? `${fmtNum(active.length)} enforced · ${fmtNum(refused)} ${refused === 1 ? "request" : "requests"} refused`
              : "Nothing enforced"
            : undefined
        }
        flush
      >
        {loading && !data ? (
          <TableSkeleton cols={7} />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} what="the blocklist" />
        ) : !hasRows ? (
          <EmptyState
            icon={Ban}
            title="Nothing blocked yet"
            action={
              <Button onClick={openAdd}>
                <Plus aria-hidden /> Add block
              </Button>
            }
          >
            Block a source from an incident or attacker profile, or add one by hand.
          </EmptyState>
        ) : (
          <Table>
            <THead cols={COLS("Expires")} />
            <tbody>
              {active.map((b) => (
                <BlockRow key={b.id} b={b} onUnblock={setTarget} />
              ))}
            </tbody>
          </Table>
        )}
      </SectionCard>

      {expired.length ? (
        <SectionCard title="Expired" detail={`${fmtNum(expired.length)} past blocks`} flush>
          <Table>
            <THead cols={COLS("Expired")} />
            <tbody>
              {expired.map((b) => (
                <BlockRow key={b.id} b={b} onUnblock={setTarget} />
              ))}
            </tbody>
          </Table>
        </SectionCard>
      ) : null}

      <Modal
        open={!!target}
        onClose={() => {
          if (!unblocking) setTarget(null);
        }}
        title={target ? `Unblock ${target.ip}?` : ""}
        actions={[
          {
            label: "Unblock source",
            tone: "danger",
            busy: unblocking,
            disabled: unblocking,
            onClick: unblock,
          },
        ]}
      >
        <p className="m-0">
          Traffic from{" "}
          <span translate="no" className="font-mono text-foreground">
            {target?.ip}
          </span>{" "}
          will reach the decoys and the app again from the next policy poll. The decoys keep scoring
          it. You can undo this from the confirmation toast.
        </p>
      </Modal>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a manual block"
        actions={[
          {
            label: "Block source",
            tone: "danger",
            busy,
            disabled: busy,
            onClick: add,
          },
        ]}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          onKeyDown={(e) => {
            // Enter submits from any text field (no hidden submit button needed).
            if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
              e.preventDefault();
              if (!busy) add();
            }
          }}
        >
          <Field
            label="IP address or CIDR"
            htmlFor="b-ip"
            hint="Example: 203.0.113.66 or 45.155.205.0/24"
            error={
              ipTouched && !validIp
                ? "Enter an IPv4 or IPv6 address, optionally with a /prefix."
                : null
            }
          >
            <Input
              id="b-ip"
              name="ip"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              translate="no"
              className="font-mono"
              value={ip}
              aria-invalid={ipTouched && !validIp ? true : undefined}
              onChange={(e) => setIp(e.target.value)}
              onBlur={() => setIpTouched(Boolean(ip.trim()))}
              placeholder="203.0.113.66…"
            />
          </Field>
          <Field label="Reason" htmlFor="b-reason">
            <Input
              id="b-reason"
              name="reason"
              type="text"
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being blocked?"
            />
          </Field>
          <Field label="Duration" htmlFor="b-dur">
            <Select
              id="b-dur"
              name="duration"
              value={hours}
              onValueChange={setHours}
              options={DURATIONS}
              aria-label="Duration"
              className="w-full"
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
