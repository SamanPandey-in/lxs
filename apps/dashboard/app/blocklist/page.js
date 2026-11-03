"use client";
import { Ban, Loader2, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Pill,
  Table,
  TableSkeleton,
  THead,
} from "@/components/ui";
import { RelativeTime, SectionCard, UnblockModal } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { stamp } from "@/lib/utils";

export default function BlocklistPage() {
  const { data, error, loading, reload } = usePolling(() => api.blocklist(PROJECT), 4000, []);
  const [target, setTarget] = useState(null);
  const [adding, setAdding] = useState(false);
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const validIp = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(ip.trim());

  const active = (data || []).filter((b) => b.status !== "expired");
  const expired = (data || []).filter((b) => b.status === "expired");

  const add = async () => {
    setBusy(true);
    try {
      await api.addBlock(PROJECT, {
        ip: ip.trim(),
        reason: reason.trim() || "Manual block",
        duration_hours: Number(hours),
      });
      toast(`Blocking ${ip.trim()}`, "success", "Pushed to sensors on the next policy poll.");
      setAdding(false);
      setIp("");
      setReason("");
      reload();
    } catch (e) {
      toast("Could not add block", "error", e.message);
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ b }) => (
    <tr>
      <td className="mono">
        <strong>{b.ip}</strong>
      </td>
      <td style={{ maxWidth: 280 }}>
        <div className="cell-clip" style={{ color: "var(--text)" }} title={b.reason}>
          {b.reason}
        </div>
      </td>
      <td>
        {b.incident_id ? (
          <Link className="table-link" prefetch={false} href={`/incidents/${b.incident_id}`}>
            {b.incident_number ? `#${b.incident_number}` : "view"}
          </Link>
        ) : (
          <span className="faint">manual</span>
        )}
      </td>
      <td>
        {b.created_by}
        <span className="table-sub">
          <RelativeTime iso={b.created_at} />
        </span>
      </td>
      <td>
        {b.status === "expired" ? (
          <span className="dim">
            expired <RelativeTime iso={b.expires_at} />
          </span>
        ) : (
          <>
            <RelativeTime iso={b.expires_at} />
            <span className="table-sub">{stamp(b.expires_at)}</span>
          </>
        )}
      </td>
      <td>
        {b.status === "applied" ? (
          <Pill tone="ok" icon={ShieldCheck}>
            Applied{b.total_sensors != null ? ` ${b.applied_sensors}/${b.total_sensors}` : ""}
          </Pill>
        ) : b.status === "pending" ? (
          <Pill tone="drift" icon={Loader2}>
            Pending{b.total_sensors != null ? ` ${b.applied_sensors}/${b.total_sensors}` : ""}
          </Pill>
        ) : (
          <Pill tone="halted">Expired</Pill>
        )}
      </td>
      <td>
        {b.status !== "expired" ? (
          <button type="button" className="btn btn-sm" onClick={() => setTarget(b)}>
            Unblock
          </button>
        ) : null}
      </td>
    </tr>
  );

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="DEFENSE / ENFORCEMENT"
        title="Blocklist"
        purpose="Sources currently refused by every sensor and the app middleware. Each change bumps the project policy version and is written to the audit log."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus /> Add block
          </button>
        }
      />

      <SectionCard title="Active blocks" detail={`${active.length} enforced`} flush>
        {loading && !data ? (
          <TableSkeleton />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : active.length === 0 ? (
          <EmptyState
            icon={Ban}
            title="Nothing blocked"
            action={
              <button type="button" className="btn" onClick={() => setAdding(true)}>
                <Plus /> Add block
              </button>
            }
          >
            Block a source from an incident, an attacker profile, or add one by hand.
          </EmptyState>
        ) : (
          <Table>
            <THead
              cols={[
                "Source",
                "Reason",
                "Incident",
                "Created by",
                "Expires",
                "Applied on sensors",
                "",
              ]}
            />
            <tbody>
              {active.map((b) => (
                <Row key={b.id} b={b} />
              ))}
            </tbody>
          </Table>
        )}
      </SectionCard>

      {expired.length ? (
        <SectionCard title="Expired" detail="History" flush>
          <Table>
            <THead cols={["Source", "Reason", "Incident", "Created by", "Expired", "State", ""]} />
            <tbody>
              {expired.map((b) => (
                <Row key={b.id} b={b} />
              ))}
            </tbody>
          </Table>
        </SectionCard>
      ) : null}

      <UnblockModal
        open={!!target}
        onClose={() => setTarget(null)}
        ip={target?.ip}
        onConfirm={async () => {
          await api.unblock(PROJECT, target.id);
          toast(`${target.ip} unblocked`, "success", "Written to the audit log.");
          reload();
        }}
      />

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a manual block"
        actions={[
          {
            label: busy ? "Adding…" : "Block",
            tone: "danger",
            disabled: !validIp || busy,
            onClick: add,
          },
        ]}
      >
        <div className="col" style={{ gap: 12 }}>
          <Field
            label="IP address or CIDR"
            htmlFor="b-ip"
            hint="Example: 203.0.113.66 or 45.155.205.0/24"
          >
            <input
              id="b-ip"
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="203.0.113.66"
            />
          </Field>
          <Field label="Reason" htmlFor="b-reason">
            <input
              id="b-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being blocked?"
            />
          </Field>
          <Field label="Duration" htmlFor="b-dur">
            <select id="b-dur" value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="1">1 hour</option>
              <option value="24">24 hours</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
            </select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}
