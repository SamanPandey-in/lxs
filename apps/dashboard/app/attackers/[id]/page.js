"use client";
import { ArrowLeft, Bot, ShieldBan, ShieldCheck, User } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  LabelPill,
  PageHeader,
  PageLoading,
  Pill,
  TechChip,
} from "@/components/ui";
import {
  BlockModal,
  describeEvent,
  IncidentsTable,
  RelativeTime,
  UnblockModal,
} from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { EVENT_LABEL, eventTone } from "@/lib/labels";
import { toast } from "@/lib/toast";
import { clock, duration, fmtNum, stamp } from "@/lib/utils";

export default function AttackerPage() {
  const { id } = useParams();
  const [blockOpen, setBlockOpen] = useState(false);
  const [unblockOpen, setUnblockOpen] = useState(false);
  const { data, error, loading, reload } = usePolling(
    async () => {
      const [a, bl] = await Promise.all([api.attacker(id), api.blocklist(PROJECT).catch(() => [])]);
      return { a, bl };
    },
    5000,
    [id],
  );

  if (loading && !data)
    return (
      <div className="ds-page">
        <PageLoading label="Loading attacker…" />
      </div>
    );
  if (error && !data)
    return (
      <div className="ds-page">
        <Link
          href="/attackers"
          className="btn btn-sm btn-ghost"
          style={{ alignSelf: "flex-start" }}
        >
          <ArrowLeft /> Attackers
        </Link>
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  const { a, bl } = data;
  const fp = a.fingerprints || {};
  const blocked =
    bl.find(
      (b) =>
        b.ip === a.ip &&
        b.status !== "expired" &&
        (!b.expires_at || new Date(b.expires_at) > new Date()),
    ) || null;

  return (
    <div className="ds-page">
      <Link
        href="/attackers"
        className="btn btn-sm btn-ghost"
        style={{ alignSelf: "flex-start", marginBottom: -8 }}
      >
        <ArrowLeft /> Attackers
      </Link>
      <PageHeader
        eyebrow="ATTACKER PROFILE"
        title={
          <span className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 22 }}>
              {a.ip}
            </span>
            <LabelPill label={a.label} large />
            <Pill
              large
              tone={a.cadence === "human" ? "bad" : "drift"}
              icon={a.cadence === "human" ? User : Bot}
            >
              {a.cadence === "human"
                ? "Human cadence"
                : a.cadence === "bot"
                  ? "Bot cadence"
                  : "Cadence unknown"}
            </Pill>
            {blocked ? (
              <Pill large tone="ok" icon={ShieldCheck}>
                Blocked
              </Pill>
            ) : null}
          </span>
        }
        purpose={`First seen ${stamp(a.first_seen_at)}, last seen ${stamp(a.last_seen_at)} (active for ${duration(a.first_seen_at, a.last_seen_at)}).`}
        actions={
          blocked ? (
            <button type="button" className="btn" onClick={() => setUnblockOpen(true)}>
              <ShieldCheck /> Unblock
            </button>
          ) : (
            <button type="button" className="btn btn-danger" onClick={() => setBlockOpen(true)}>
              <ShieldBan /> Block source
            </button>
          )
        }
      />

      <div className="grid-2">
        <Card title="Facts">
          <dl className="ds-facts">
            <div>
              <dt>Events</dt>
              <dd>{fmtNum(a.event_count)}</dd>
            </div>
            <div>
              <dt>Sessions</dt>
              <dd>{a.session_count}</dd>
            </div>
            <div>
              <dt>Client banner</dt>
              <dd className="mono">{fp.client_banner || "—"}</dd>
            </div>
            <div>
              <dt>Origin</dt>
              <dd>{fp.country || "—"}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{fp.asn || "—"}</dd>
            </div>
            <div>
              <dt>Entity key</dt>
              <dd className="mono">{a.entity_key}</dd>
            </div>
          </dl>
          <div className="ds-section" style={{ marginTop: 14 }}>
            <h3>Decoys touched</h3>
            <div className="row-wrap" style={{ gap: 6 }}>
              {a.decoys_touched.map((d) => (
                <Pill tone="cache" key={d}>
                  {d}
                </Pill>
              ))}
            </div>
          </div>
          {a.real_assets_touched?.length ? (
            <div className="ds-section" style={{ marginTop: 14 }}>
              <h3>Real assets touched</h3>
              <div className="row-wrap" style={{ gap: 6 }}>
                {a.real_assets_touched.map((d) => (
                  <Pill tone="bad" key={d}>
                    {d}
                  </Pill>
                ))}
              </div>
            </div>
          ) : null}
          {fp.user_agents?.length ? (
            <div className="ds-section" style={{ marginTop: 14 }}>
              <h3>User agents</h3>
              <ul className="ds-list">
                {fp.user_agents.map((u) => (
                  <li key={u}>
                    <code className="code" style={{ padding: "2px 8px" }}>
                      {u}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card title="Behaviour" sub="Attacker-supplied text, rendered as data">
          <div className="detail-stack" style={{ gap: 14 }}>
            <div className="ds-section">
              <h3>ATT&amp;CK techniques</h3>
              <div className="row-wrap" style={{ gap: 5 }}>
                {(a.techniques || []).map((t) => (
                  <TechChip key={t} id={t} />
                ))}
                {!a.techniques?.length ? <span className="dim">None mapped.</span> : null}
              </div>
            </div>
            <div className="ds-section">
              <h3>Credentials tried (masked)</h3>
              <div className="row-wrap" style={{ gap: 5 }}>
                {(fp.credentials_tried || []).map((c) => (
                  <Chip key={c}>{c}</Chip>
                ))}
                {!fp.credentials_tried?.length ? <span className="dim">None.</span> : null}
              </div>
            </div>
            <div className="ds-section">
              <h3>Commands</h3>
              {fp.commands?.length ? (
                <ul className="ds-list">
                  {fp.commands.map((c) => (
                    <li key={c}>
                      <code
                        className="code"
                        style={{ padding: "2px 8px", maxWidth: "100%", overflowX: "auto" }}
                      >
                        {c}
                      </code>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="dim">No shell commands.</span>
              )}
            </div>
            <div className="ds-section">
              <h3>Files</h3>
              <div className="row-wrap" style={{ gap: 5 }}>
                {(fp.files || []).map((c) => (
                  <Chip key={c}>{c}</Chip>
                ))}
                {!fp.files?.length ? <span className="dim">None.</span> : null}
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Linked incidents" flush>
        {a.incidents?.length ? (
          <IncidentsTable incidents={a.incidents} />
        ) : (
          <EmptyState title="No incidents">
            This source has not yet crossed the incident threshold.
          </EmptyState>
        )}
      </Card>

      <Card title="Recent events" flush>
        {a.recent_events?.length ? (
          <div className="ds-feed">
            {a.recent_events.slice(0, 12).map((e) => (
              <div className="ds-event" key={e.id}>
                <span className="ds-dot" data-tone={eventTone(e)} />
                <div className="ds-event-main">
                  <div className="ds-event-title">{EVENT_LABEL[e.event_type] || e.event_type}</div>
                  <div className="ds-event-meta mono">{describeEvent(e)}</div>
                </div>
                <span className="ds-event-time">
                  {clock(e.occurred_at)} · <RelativeTime iso={e.occurred_at} />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No recent events" />
        )}
      </Card>

      <BlockModal
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        ip={a.ip}
        onDone={() => {
          reload();
          setTimeout(reload, 3000);
        }}
      />
      <UnblockModal
        open={unblockOpen}
        onClose={() => setUnblockOpen(false)}
        ip={a.ip}
        onConfirm={async () => {
          await api.unblock(PROJECT, blocked.id);
          toast(`${a.ip} unblocked`);
          reload();
        }}
      />
    </div>
  );
}
