"use client";
import {
  Check,
  Clock,
  Cpu,
  FileText,
  Lock,
  Network,
  ShieldAlert,
  ShieldCheck,
  X as XIcon,
} from "lucide-react";
import { useState } from "react";
import {
  CodeBlock,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  StatTile,
  Table,
  TableSkeleton,
  THead,
} from "@/components/ui";
import { RelativeTime, SectionCard } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useNow, usePolling } from "@/lib/hooks";
import { fmtNum, relative, stamp } from "@/lib/utils";

const TYPE_TONE = { web: "rejected", ssh: "cache", redis: "drift" };

export default function DecoysPage() {
  const now = useNow(5000);
  const dec = usePolling(() => api.decoys(PROJECT), 6000, []);
  const con = usePolling(() => api.containment(PROJECT), 10000, []);
  const [report, setReport] = useState(null);

  const c = con.data;
  const pass = c && c.status !== "fail" && c.passed === c.total;
  const first = c?.containers?.[0]?.declared;

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="DEFENSE / SAFETY PROOF"
        title="Decoys & containment"
        purpose="Proof the honeypots cannot hurt you, and a live look at every sensor. Containment is declared in config and verified by a self-test inside each container."
      />

      {c ? (
        <div className="ds-proof" data-tone={pass ? undefined : "bad"}>
          <span className="vb-ico">
            {pass ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
          </span>
          <div style={{ flex: 1 }}>
            <h2>
              Containment: {pass ? "PASS" : "FAIL"} ({c.passed}/{c.total})
            </h2>
            <div className="dim">
              Last self-test ran <RelativeTime iso={c.last_run_at} /> ({stamp(c.last_run_at)}).
              Egress blocked, filesystem read-only, capabilities dropped, no path to production.
            </div>
          </div>
          <button type="button" className="btn" onClick={() => setReport(c.containers[0])}>
            <FileText /> View report
          </button>
        </div>
      ) : con.loading ? (
        <TableSkeleton rows={2} />
      ) : (
        <ErrorState error={con.error} onRetry={con.reload} />
      )}

      {first ? (
        <div className="ds-tile-grid">
          <StatTile
            label="Network mode"
            value={
              <span style={{ fontSize: 15, lineHeight: 1.5, display: "block", marginTop: 12 }}>
                {first.network_mode}
              </span>
            }
            tone="ok"
            icon={Network}
          />
          <StatTile
            label="Root filesystem"
            value={first.read_only === false ? "Writable" : first.read_only ? "Read-only" : "—"}
            hint="Bait mounted :ro"
            tone={first.read_only === false ? "bad" : "ok"}
            icon={Lock}
          />
          <StatTile
            label="Capabilities dropped"
            value={first.cap_drop}
            hint={`${first.user} · no-new-privileges`}
            tone="ok"
            icon={Cpu}
          />
          <StatTile
            label="Last run"
            value={relative(c.last_run_at, now)}
            hint={stamp(c.last_run_at)}
            tone="healed"
            icon={Clock}
          />
        </div>
      ) : null}

      <SectionCard
        title="Sensors"
        detail="One row per decoy: type, persona, last event, last heartbeat"
        flush
      >
        {dec.loading && !dec.data ? (
          <TableSkeleton />
        ) : dec.error && !dec.data ? (
          <ErrorState error={dec.error} onRetry={dec.reload} />
        ) : !dec.data?.length ? (
          <EmptyState title="No decoys registered">
            Run <code>npx lxs init</code> and <code>docker compose up</code>. Decoys register
            themselves on first heartbeat.
          </EmptyState>
        ) : (
          <div>
            {dec.data.map((d) => (
              <div
                className="health-row"
                key={d.id}
                style={{ padding: "12px 16px", flexWrap: "wrap" }}
              >
                <span
                  className={`health-dot ${d.status === "online" ? "is-live" : d.status === "offline" ? "is-offline" : "is-pending"}`}
                />
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <strong>{d.name}</strong>
                    <span className="mono dim">{d.id}</span>
                    <Pill tone={TYPE_TONE[d.type] || "halted"}>{d.type}</Pill>
                  </div>
                  <div className="ds-res-meta">
                    {d.persona} · <span className="mono">{d.service}</span>
                  </div>
                </div>
                <div className="ds-res-meta" style={{ flex: "0 0 150px" }}>
                  Last event
                  <br />
                  <strong style={{ color: "var(--text)" }}>{relative(d.last_event_at, now)}</strong>
                </div>
                <div className="ds-res-meta" style={{ flex: "0 0 150px" }}>
                  Heartbeat
                  <br />
                  <strong style={{ color: d.status === "online" ? "var(--text)" : "var(--drift)" }}>
                    {relative(d.last_heartbeat_at, now)}
                  </strong>
                </div>
                <div className="ds-res-meta" style={{ flex: "0 0 120px" }}>
                  Events 24 h<br />
                  <strong className="num" style={{ color: "var(--text)" }}>
                    {fmtNum(d.events_24h)}
                  </strong>
                </div>
                <div className="ds-res-meta" style={{ flex: "0 0 110px" }}>
                  Agent
                  <br />
                  <span className="mono">{d.agent_version}</span> · policy {d.policy_version}
                </div>
                <Pill
                  tone={d.status === "online" ? "ok" : d.status === "offline" ? "bad" : "drift"}
                >
                  {d.status === "online" ? "Online" : d.status === "offline" ? "Offline" : "Stale"}
                </Pill>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Declared posture vs self-test"
        detail="What the manifest promises, and what the last self-test measured"
        flush
      >
        {c ? (
          <Table>
            <THead
              cols={[
                "Container",
                "Network",
                "Read-only",
                "Caps",
                "User",
                "Limits",
                "Self-test",
                "Last run",
                "",
              ]}
            />
            <tbody>
              {c.containers.map((k) => (
                <tr key={k.container}>
                  <td className="mono">{k.container}</td>
                  <td>{k.declared.network_mode}</td>
                  <td>
                    {k.declared.read_only === true ? (
                      <Pill tone="ok">yes</Pill>
                    ) : k.declared.read_only === false ? (
                      <Pill tone="bad">no</Pill>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="mono">drop {k.declared.cap_drop}</td>
                  <td className="mono">{k.declared.user}</td>
                  <td className="mono">
                    {k.declared.mem_limit} · {k.declared.pids_limit} pids
                  </td>
                  <td>
                    <Pill
                      tone={k.selftest.status === "pass" ? "ok" : "bad"}
                      icon={k.selftest.status === "pass" ? Check : XIcon}
                    >
                      {k.selftest.status === "pass"
                        ? `${k.selftest.checks.length}/${k.selftest.checks.length} pass`
                        : "fail"}
                    </Pill>
                  </td>
                  <td>
                    <RelativeTime iso={k.selftest.run_at} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setReport(k)}>
                      Report
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <TableSkeleton rows={3} />
        )}
      </SectionCard>

      <SectionCard
        title="Run the self-test yourself"
        detail="Posts a signed report back to the platform and refreshes this page"
      >
        <CodeBlock>{c?.command || "npx lxs selftest --project acme-shop --report"}</CodeBlock>
      </SectionCard>

      <Drawer
        open={!!report}
        onClose={() => setReport(null)}
        title={report ? `Self-test · ${report.container}` : ""}
      >
        {report ? (
          <div className="detail-stack">
            <dl className="ds-facts">
              <div>
                <dt>Result</dt>
                <dd>
                  <Pill tone={report.selftest.status === "pass" ? "ok" : "bad"}>
                    {report.selftest.status.toUpperCase()}
                  </Pill>
                </dd>
              </div>
              <div>
                <dt>Run at</dt>
                <dd>{stamp(report.selftest.run_at)}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{report.declared.network_mode}</dd>
              </div>
              <div>
                <dt>User</dt>
                <dd className="mono">{report.declared.user}</dd>
              </div>
            </dl>
            <div className="ds-section">
              <h3>Checks</h3>
              <ul className="ds-list" style={{ gap: 10 }}>
                {report.selftest.checks.map((k) => (
                  <li key={k.name} style={{ alignItems: "flex-start" }}>
                    <Pill
                      tone={k.status === "pass" ? "ok" : "bad"}
                      icon={k.status === "pass" ? Check : XIcon}
                    >
                      {k.status}
                    </Pill>
                    <div>
                      <div style={{ fontWeight: 560 }}>{k.name}</div>
                      <div className="mono dim" style={{ fontSize: 11.5 }}>
                        {k.detail}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <CodeBlock>{JSON.stringify(report, null, 2)}</CodeBlock>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
