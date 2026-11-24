"use client";
import { Activity, AlertTriangle, Layers, RotateCcw, Server, Sparkles } from "lucide-react";
import { useState } from "react";
import { RateArea } from "@/components/charts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  PageLoading,
  StatTile,
} from "@/components/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/workspace";
import { api } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { cn, fmtNum } from "@/lib/utils";

const NBSP = " ";
const pct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const secs = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function uptime(seconds) {
  if (seconds == null) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d
    ? `${d}${NBSP}d ${h}${NBSP}h`
    : `${h}${NBSP}h ${Math.floor((seconds % 3600) / 60)}${NBSP}min`;
}
const latency = (ms) => (ms ? `${secs.format(ms / 1000)}${NBSP}s` : "—");

/** One key/value row in a definition list. Empty values render as a muted em dash. */
function Fact({ label, children, mono }) {
  const empty = children == null || children === "" || children === "—";
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "m-0 min-w-0 truncate text-right text-sm tabular-nums",
          empty ? "text-muted-foreground" : "font-medium text-foreground",
          mono && !empty && "font-mono",
        )}
      >
        {empty ? "—" : children}
      </dd>
    </div>
  );
}

export default function SystemPage() {
  const { data: s, error, loading, reload } = usePolling(() => api.system(), 6000, []);
  const [retrying, setRetrying] = useState(null);

  if (loading && !s) return <PageLoading label="Loading platform health" />;
  if (error && !s) return <ErrorState error={error} onRetry={reload} what="platform health" />;

  const retry = async (j) => {
    setRetrying(j.id);
    try {
      await api.retryJob(j.id);
      toast(`Retried ${j.name}`, "success");
      reload();
    } catch (e) {
      toast("Retry failed", "error", e.message);
    } finally {
      setRetrying(null);
    }
  };

  const llm = s.llm || {};
  // The real API reports "—" (or nothing) when no model is set up: never show that as 0 %.
  const llmConfigured =
    Boolean(llm.model) && llm.model !== "—" && llm.model !== "not configured" && llm.ok !== false;
  const llmRan = llmConfigured && Number(llm.calls_24h) > 0;
  const failed = s.failed_jobs || [];
  const agents = s.agents || [];
  const meta = [
    s.version ? `Version ${s.version}` : null,
    uptime(s.uptime_seconds) && `up ${uptime(s.uptime_seconds)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <PageHeader
          title="Platform health"
          purpose="Is the pipeline healthy? Ingest, queue, the LLM narrator and the agents shipping events."
        />
        {meta ? <p className="m-0 text-xs text-muted-foreground tabular-nums">{meta}</p> : null}
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile
          label="Ingest per minute"
          value={fmtNum(s.ingest_rate_per_min ?? 0)}
          hint="Events accepted by POST /v1/ingest"
          tone="healed"
          icon={Activity}
        />
        <StatTile
          label="Queue depth"
          value={fmtNum(s.queue_depth ?? 0)}
          hint="Jobs waiting (pg-boss)"
          tone={s.queue_depth > 50 ? "drift" : undefined}
          icon={Layers}
        />
        <StatTile
          label="Failed jobs"
          value={failed.length}
          hint={failed.length ? "Needs a retry or a look" : "All clear"}
          tone={failed.length ? "drift" : undefined}
          icon={AlertTriangle}
        />
        <StatTile
          label="LLM success"
          value={llmRan ? pct.format(llm.success_rate || 0) : "—"}
          hint={
            !llmConfigured
              ? "Not configured · template summaries"
              : llmRan
                ? `p50 ${latency(llm.p50_ms)} · p95 ${latency(llm.p95_ms)}`
                : "No narrations in the last 24 h"
          }
          tone={llmRan ? "cache" : undefined}
          icon={Sparkles}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Ingest volume, last 24 h"
          sub="Events per hour across all sensors"
        >
          <RateArea
            data={s.ingest_series}
            emptyHint="Events appear here as soon as a sensor or the SDK sends one."
          />
        </Card>
        <Card title="LLM narrator">
          <dl className="m-0">
            <Fact label="Model" mono={llmConfigured}>
              {llmConfigured ? llm.model : "Not configured"}
            </Fact>
            {!llmConfigured && <Fact label="Mode">Template summaries</Fact>}
            <Fact label="Narrations (24 h)">
              {llmConfigured ? fmtNum(llm.calls_24h ?? 0) : null}
            </Fact>
            <Fact label="Template fallbacks">
              {llmConfigured ? fmtNum(llm.fallbacks_24h ?? 0) : null}
            </Fact>
            <Fact label="Median latency">{llmRan ? latency(llm.p50_ms) : null}</Fact>
            <Fact label="Stream connections">{fmtNum(s.stream_connections ?? 0)}</Fact>
          </dl>
        </Card>
      </div>

      <Card
        title="Failed jobs"
        sub="Narration and notification jobs retry automatically 5 times"
        flush
      >
        {failed.length === 0 ? (
          <EmptyState icon={AlertTriangle} title="No failed jobs">
            Every background job has completed.
          </EmptyState>
        ) : (
          <Table inset>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Job</TableHead>
                <TableHead scope="col">Error</TableHead>
                <TableHead scope="col" className="text-right">
                  Attempts
                </TableHead>
                <TableHead scope="col">Failed</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failed.map((j) => (
                <TableRow key={j.id} className="h-11">
                  <TableCell>
                    <div className="font-medium text-foreground">{j.name}</div>
                    <div className="font-mono text-xs text-muted-foreground" translate="no">
                      {j.id}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-md text-muted-foreground [overflow-wrap:anywhere]">
                    {j.error}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(j.attempts)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <RelativeTime iso={j.failed_at} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      loading={retrying === j.id}
                      onClick={() => retry(j)}
                      aria-label={`Retry ${j.name}`}
                    >
                      {retrying === j.id ? null : <RotateCcw aria-hidden />} Retry
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card title="Agents" sub="Sensor agents and their versions" flush>
        {agents.length === 0 ? (
          <EmptyState icon={Server} title="No agents connected">
            An agent appears here after its first heartbeat. See Get started for the install
            command.
          </EmptyState>
        ) : (
          <Table inset>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Agent</TableHead>
                <TableHead scope="col">Host</TableHead>
                <TableHead scope="col">Version</TableHead>
                <TableHead scope="col">Last heartbeat</TableHead>
                <TableHead scope="col" className="text-right">
                  Buffered
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Dropped
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => (
                <TableRow key={a.id} className="h-11">
                  <TableCell className="font-mono font-medium whitespace-nowrap" translate="no">
                    {a.id}
                  </TableCell>
                  <TableCell className="whitespace-nowrap" translate="no">
                    {a.host}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="font-mono" translate="no">
                        {a.version}
                      </span>
                      {a.outdated ? (
                        <Badge variant="tag" tone="warn" title={`Latest is ${a.latest}`}>
                          Outdated
                        </Badge>
                      ) : (
                        <Badge variant="status" tone="ok">
                          Current
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <RelativeTime iso={a.last_heartbeat_at} />
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      !Number(a.buffer) && "text-muted-foreground",
                    )}
                  >
                    {fmtNum(a.buffer ?? 0)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      !Number(a.dropped) && "text-muted-foreground",
                    )}
                  >
                    {fmtNum(a.dropped ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
