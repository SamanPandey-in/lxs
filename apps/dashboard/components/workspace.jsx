"use client";
import { Coins, KeyRound, Search, ShieldBan } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, PROJECT } from "@/lib/core";
import { useNow } from "@/lib/hooks";
import { EVENT_LABEL, eventTone } from "@/lib/labels";
import { toast } from "@/lib/toast";
import { clock, relative, stamp } from "@/lib/utils";
import { KillMini } from "./killchain";
import {
  Card,
  Field,
  LabelPill,
  Modal,
  Pill,
  SeverityPill,
  StatusPill,
  Table,
  TechChip,
  THead,
} from "./ui";

export { stamp, clock };
export { duration } from "@/lib/utils";

export function SectionCard({ title, detail, action, children, flush }) {
  return (
    <Card title={title} sub={detail} right={action} flush={flush}>
      {children}
    </Card>
  );
}

export function RelativeTime({ iso }) {
  const now = useNow(5000);
  return (
    <time dateTime={iso} title={iso ? new Date(iso).toLocaleString() : ""}>
      {relative(iso, now)}
    </time>
  );
}

export function RouteLink({ href, children, className = "table-link" }) {
  return (
    // No prefetch: a table renders one of these per row.
    <Link href={href} className={className} prefetch={false}>
      {children}
    </Link>
  );
}

export function FilterSelect({ label, value, onChange, options }) {
  return (
    <div className="filter-field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TextFilter({ value, onChange, placeholder = "Search…", label = "Search" }) {
  return (
    <div className="ds-filter-search">
      <Search aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </div>
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

export function EventDot({ e }) {
  return <span className="ds-dot" data-tone={eventTone(e)} />;
}

/* ───────── Incidents table ───────── */
export function IncidentsTable({ incidents, emptyHint }) {
  const router = useRouter();
  if (!incidents.length) return null;
  const open = (id) => router.push(`/incidents/${id}`);
  return (
    <Table>
      <THead
        cols={[
          "Severity",
          { label: "Score", num: true },
          "Incident",
          "Kill chain",
          "ATT&CK",
          "Last activity",
          "Status",
        ]}
      />
      <tbody>
        {incidents.map((i) => (
          <tr
            key={i.id}
            className="interactive-row"
            tabIndex={0}
            onClick={() => open(i.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") open(i.id);
            }}
          >
            <td>
              <SeverityPill severity={i.severity} />
            </td>
            <td className="num">
              <strong>{i.score}</strong>
            </td>
            <td style={{ minWidth: 330, maxWidth: 420 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <Link
                  href={`/incidents/${i.id}`}
                  className="table-link"
                  prefetch={false}
                  onClick={(e) => e.stopPropagation()}
                >
                  #{i.number} {i.title}
                </Link>
              </div>
              <span className="table-sub row" style={{ gap: 6, flexWrap: "wrap", marginTop: 3 }}>
                <span className="mono">{i.src_ip}</span>
                <LabelPill label={i.label} />
                {i.real_asset_reached ? (
                  <Pill tone="bad" icon={Coins}>
                    Real asset
                  </Pill>
                ) : null}
                {i.honeytoken_used ? (
                  <Pill tone="bad" icon={KeyRound}>
                    Honeytoken
                  </Pill>
                ) : null}
              </span>
            </td>
            <td>
              <KillMini stages={i.stages} severity={i.severity} />
            </td>
            <td>
              <div className="row incident-techniques">
                {i.techniques.slice(0, 4).map((t) => (
                  <TechChip key={t} id={t} link={false} />
                ))}
                {i.techniques.length > 4 ? (
                  <span className="chip" title={i.techniques.slice(4).join(", ")}>
                    +{i.techniques.length - 4}
                  </span>
                ) : null}
              </div>
            </td>
            <td style={{ whiteSpace: "nowrap" }}>
              <RelativeTime iso={i.last_event_at} />
            </td>
            <td>
              <StatusPill status={i.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ───────── Block / unblock confirm modals ───────── */
export function BlockModal({ open, onClose, ip, incident, onDone }) {
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false);
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
        `Blocked for ${hours} h · written to the audit log`,
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
          label: busy ? "Blocking…" : `Block for ${hours} h`,
          tone: "danger",
          onClick: submit,
          disabled: busy,
        },
      ]}
    >
      <p>
        <strong style={{ color: "var(--text)" }}>{ip}</strong> will be added to the project
        blocklist and pushed to every sensor and the app middleware in{" "}
        <strong style={{ color: "var(--text)" }}>Acme Shop</strong>. Its next request will be
        refused. One row is written to the audit log.
      </p>
      <div style={{ marginTop: 12 }}>
        <Field label="Duration" htmlFor="blk-dur">
          <select id="blk-dur" value={hours} onChange={(e) => setHours(e.target.value)}>
            <option value="1">1 hour</option>
            <option value="24">24 hours</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export function UnblockModal({ open, onClose, ip, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Unblock ${ip}?`}
      actions={[
        {
          label: busy ? "Unblocking…" : "Unblock",
          tone: "primary",
          disabled: busy,
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
      <p>
        Unblock <strong style={{ color: "var(--text)" }}>{ip}</strong> in{" "}
        <strong style={{ color: "var(--text)" }}>Acme Shop</strong>? Traffic from this source will
        be allowed again and the decoys will keep scoring it.
      </p>
    </Modal>
  );
}

/* ───────── Audit table ───────── */
export function AuditTable({ rows, onOpen }) {
  return (
    <Table>
      <THead cols={["Time", "Actor", "Action", "Target", "Metadata"]} />
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            className="interactive-row"
            tabIndex={0}
            onClick={() => onOpen(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(r);
              }
            }}
          >
            <td style={{ whiteSpace: "nowrap" }} className="mono">
              {stamp(r.at)}
            </td>
            <td>{r.actor === "system" ? <Pill tone="halted">system</Pill> : r.actor}</td>
            <td>
              <Pill
                tone={
                  r.action.includes("block") && !r.action.includes("unblock")
                    ? "bad"
                    : r.action.startsWith("incident")
                      ? "cache"
                      : r.action === "unblock_ip"
                        ? "ok"
                        : "halted"
                }
              >
                {r.action}
              </Pill>
            </td>
            <td>{r.target}</td>
            <td>
              <div className="cell-clip mono" style={{ maxWidth: 300 }}>
                {JSON.stringify(r.metadata)}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export { EVENT_LABEL, ShieldBan };
