"use client";
import {
  Check,
  CircleDashed,
  Clock,
  Cpu,
  Lock,
  Network,
  Radar,
  ShieldAlert,
  X as XIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  CodeBlock,
  CommandCopy,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  StatTile,
  StatusDot,
  Table,
  TableSkeleton,
  THead,
} from "@/components/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RelativeTime, SectionCard } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useNow, usePolling } from "@/lib/hooks";
import { fmtNum, relative, stamp } from "@/lib/utils";

const SETUP_CMD = "npx lxs init && docker compose up -d";
const SELFTEST_CMD = "npx lxs selftest --report";

const SENSOR_STATUS = {
  online: { tone: "ok", label: "Online" },
  offline: { tone: "bad", label: "Offline" },
};
const sensorStatus = (s) => SENSOR_STATUS[s] || { tone: "warn", label: "Stale" };

function SelftestBadge({ status, n }) {
  const pass = status === "pass";
  return (
    <Badge variant="tag" tone={pass ? "ok" : "bad"}>
      {pass ? <Check aria-hidden /> : <XIcon aria-hidden />}
      {pass ? (n != null ? `Passed ${n}/${n}` : "Passed") : "Failed"}
    </Badge>
  );
}

function SensorRow({ d, now }) {
  const st = sensorStatus(d.status);
  return (
    <li className="grid min-w-0 gap-x-6 gap-y-2 px-5 py-3 md:grid-cols-[minmax(0,1fr)_repeat(4,minmax(0,7.5rem))_6rem] md:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-base font-medium text-foreground">{d.name}</span>
          <span translate="no" className="font-mono text-xs text-muted-foreground">
            {d.key ?? d.id}
          </span>
          <Badge variant="tag" tone="neutral">
            {d.type}
          </Badge>
        </div>
        <div className="truncate text-sm text-muted-foreground" title={`${d.persona} · ${d.service}`}>
          {d.persona} · <span className="font-mono">{d.service}</span>
        </div>
      </div>
      <Meta label="Last event">{relative(d.last_event_at, now)}</Meta>
      <Meta label="Heartbeat">
        <span className={d.status === "online" ? undefined : "text-warn"}>
          {relative(d.last_heartbeat_at, now)}
        </span>
      </Meta>
      <Meta label="Events 24 h">
        <span className={d.events_24h ? "tabular-nums" : "tabular-nums text-muted-foreground"}>
          {fmtNum(d.events_24h)}
        </span>
      </Meta>
      <Meta label="Agent">
        <span translate="no" className="font-mono">
          {d.agent_version}
        </span>
        <span className="text-muted-foreground"> · policy {d.policy_version}</span>
      </Meta>
      <div className="md:justify-self-end">
        <StatusDot tone={st.tone}>{st.label}</StatusDot>
      </div>
    </li>
  );
}

function Meta({ label, children }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-sm md:block">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 truncate text-foreground tabular-nums">{children}</div>
    </div>
  );
}

export default function DecoysPage() {
  const now = useNow(5000);
  const dec = usePolling(() => api.decoys(PROJECT), 6000, []);
  const con = usePolling(() => api.containment(PROJECT), 10000, []);
  const [report, setReport] = useState(null);

  const c = con.data;
  const hasReport = Boolean(c?.total > 0 && c.containers?.length);
  const pass = hasReport && c.status !== "fail" && c.passed === c.total;
  const first = hasReport ? c.containers[0].declared : null;
  const noDecoys = !dec.loading && !dec.error && dec.data && dec.data.length === 0;

  const header = (
    <PageHeader
      title="Decoys & containment"
      purpose="Proof the decoys cannot hurt you, and a live look at every sensor. Containment is declared in config and verified by a self-test inside each container."
    />
  );

  // One clear state when nothing is deployed yet: no warning banner stacked over it (C1).
  if (noDecoys) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        {header}
        <SectionCard title="Sensors">
          <EmptyState
            icon={Radar}
            title="No decoys registered"
            action={<CommandCopy cmd={SETUP_CMD} />}
          >
            Decoys register themselves on their first heartbeat. Start the decoy stack from your
            project folder:
          </EmptyState>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {header}

      {hasReport && !pass ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden />
          <AlertTitle className="text-base font-medium">
            Containment failed: {c.passed} of {c.total} checks passed
          </AlertTitle>
          <AlertDescription className="text-sm">
            Open the failing container's report below and fix its declared posture before exposing
            the decoys.
          </AlertDescription>
        </Alert>
      ) : null}

      {first ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Network mode" value={first.network_mode} tone="ok" icon={Network} />
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
            label="Last self-test"
            value={relative(c.last_run_at, now)}
            hint={stamp(c.last_run_at)}
            icon={Clock}
          />
        </div>
      ) : null}

      <SectionCard
        title="Containment"
        detail={
          hasReport ? (
            <>
              Declared posture vs the last self-test, run <RelativeTime iso={c.last_run_at} />
            </>
          ) : (
            "Declared posture vs the last self-test"
          )
        }
        action={
          hasReport ? (
            <StatusDot tone={pass ? "ok" : "bad"}>
              {pass ? "Passed" : "Failed"} {c.passed}/{c.total}
            </StatusDot>
          ) : c ? (
            <StatusDot tone="neutral">Not run</StatusDot>
          ) : null
        }
        flush
      >
        {con.loading && !c ? (
          <TableSkeleton rows={3} cols={6} />
        ) : con.error && !c ? (
          <ErrorState error={con.error} onRetry={con.reload} what="the containment report" />
        ) : !hasReport ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-5 py-3 text-sm">
            <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              No sensor has submitted a containment report yet. Run the self-test:
            </span>
            <CommandCopy cmd={c?.command || SELFTEST_CMD} />
          </div>
        ) : (
          <>
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
                    <td translate="no" className="font-mono">
                      {k.container}
                    </td>
                    <td>{k.declared.network_mode}</td>
                    <td>
                      {k.declared.read_only === true ? (
                        <Badge variant="tag" tone="ok">
                          Yes
                        </Badge>
                      ) : k.declared.read_only === false ? (
                        <Badge variant="tag" tone="bad">
                          No
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="font-mono">drop {k.declared.cap_drop}</td>
                    <td className="font-mono">{k.declared.user}</td>
                    <td className="font-mono tabular-nums">
                      {k.declared.mem_limit} · {k.declared.pids_limit} pids
                    </td>
                    <td>
                      <SelftestBadge
                        status={k.selftest.status}
                        n={k.selftest.status === "pass" ? k.selftest.checks.length : null}
                      />
                    </td>
                    <td className="whitespace-nowrap tabular-nums">
                      <RelativeTime iso={k.selftest.run_at} />
                    </td>
                    <td className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setReport(k)}
                        aria-label={`View self-test report for ${k.container}`}
                      >
                        View report
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-5 py-3 text-sm">
              <span className="text-muted-foreground">
                Re-run the self-test. It posts a signed report and this page refreshes:
              </span>
              <CommandCopy cmd={c.command || SELFTEST_CMD} />
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Sensors"
        detail="One row per decoy: type, persona, last event, last heartbeat"
        flush
      >
        {dec.loading && !dec.data ? (
          <TableSkeleton cols={6} />
        ) : dec.error && !dec.data ? (
          <ErrorState error={dec.error} onRetry={dec.reload} what="sensors" />
        ) : (
          <ul className="m-0 list-none divide-y divide-border border-t border-border p-0">
            {dec.data.map((d) => (
              <SensorRow key={d.id} d={d} now={now} />
            ))}
          </ul>
        )}
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
                  <SelftestBadge status={report.selftest.status} />
                </dd>
              </div>
              <div>
                <dt>Run at</dt>
                <dd className="tabular-nums">{stamp(report.selftest.run_at)}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{report.declared.network_mode}</dd>
              </div>
              <div>
                <dt>User</dt>
                <dd className="font-mono">{report.declared.user}</dd>
              </div>
            </dl>
            <div className="ds-section">
              <h3>Checks</h3>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {report.selftest.checks.map((k) => (
                  <li key={k.name} className="flex min-w-0 items-start gap-3">
                    <SelftestBadge status={k.status} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">{k.name}</div>
                      {k.detail ? (
                        <div className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {k.detail}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <CodeBlock label="Raw report">{JSON.stringify(report, null, 2)}</CodeBlock>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
