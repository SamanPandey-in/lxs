"use client";
import { Activity, AlertTriangle, Layers, Radio, RotateCcw, Sparkles } from "lucide-react";
import { RateArea } from "@/components/charts";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageLoading,
  Pill,
  StatTile,
  Table,
  THead,
} from "@/components/ui";
import { RelativeTime, SectionCard } from "@/components/workspace";
import { api } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { fmtNum, mmss } from "@/lib/utils";

export default function SystemPage() {
  const { data: s, error, loading, reload } = usePolling(() => api.system(), 6000, []);
  if (loading && !s)
    return (
      <div className="ds-page">
        <PageLoading />
      </div>
    );
  if (error && !s)
    return (
      <div className="ds-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  const retry = async (j) => {
    try {
      await api.retryJob(j.id);
      toast(`Retried ${j.name}`, "success");
      reload();
    } catch (e) {
      toast("Retry failed", "error", e.message);
    }
  };
  const llm = s.llm || {};

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="SYSTEM / OWNER"
        title="Platform health"
        purpose="Is the pipeline healthy? Ingest, queue, LLM narrator, and the agents shipping events."
        actions={
          <>
            <Pill tone="ok">v{s.version}</Pill>
            <Pill tone="halted">
              up {Math.floor(s.uptime_seconds / 86400)}d{" "}
              {Math.floor((s.uptime_seconds % 86400) / 3600)}h
            </Pill>
          </>
        }
      />

      <div className="overview-metrics">
        <StatTile
          label="Ingest rate"
          value={`${fmtNum(s.ingest_rate_per_min)}/min`}
          hint="Events accepted by POST /v1/ingest"
          tone="healed"
          icon={Activity}
        />
        <StatTile
          label="Queue depth"
          value={s.queue_depth}
          hint="Jobs waiting (pg-boss)"
          tone={s.queue_depth > 50 ? "drift" : "ok"}
          icon={Layers}
        />
        <StatTile
          label="Failed jobs"
          value={s.failed_jobs.length}
          hint={s.failed_jobs.length ? "Needs a retry or a look" : "All clear"}
          tone={s.failed_jobs.length ? "drift" : "ok"}
          icon={AlertTriangle}
        />
        <StatTile
          label="LLM success"
          value={`${Math.round((llm.success_rate || 0) * 100)}%`}
          hint={`p50 ${((llm.p50_ms || 0) / 1000).toFixed(1)} s · p95 ${((llm.p95_ms || 0) / 1000).toFixed(1)} s`}
          tone="cache"
          icon={Sparkles}
        />
      </div>

      <div className="overview-grid">
        <SectionCard title="Ingest volume, last 24 h" detail="Events per hour across all sensors">
          <RateArea data={s.ingest_series} />
        </SectionCard>
        <SectionCard title="LLM narrator" flush>
          <div className="glance">
            <div className="glance-row">
              <span className="dim">Model</span>
              <strong className="mono">{llm.model || "not configured"}</strong>
            </div>
            {!llm.model && (
              <div className="glance-row">
                <span className="dim">Mode</span>
                <strong>Deterministic template summaries</strong>
              </div>
            )}
            <div className="glance-row">
              <span className="dim">Narrations (24 h)</span>
              <strong className="num">{llm.calls_24h}</strong>
            </div>
            <div className="glance-row">
              <span className="dim">Template fallbacks</span>
              <strong className="num">{llm.fallbacks_24h}</strong>
            </div>
            <div className="glance-row">
              <span className="dim">Median latency</span>
              <strong className="num">{mmss((llm.p50_ms || 0) / 1000)}</strong>
            </div>
            <div className="glance-row">
              <span className="dim">Stream connections</span>
              <strong className="num">{s.stream_connections}</strong>
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Failed jobs"
        detail="Narration and notification jobs retry automatically 5 times"
        flush
      >
        {s.failed_jobs.length === 0 ? (
          <EmptyState icon={AlertTriangle} title="No failed jobs">
            Every background job has completed.
          </EmptyState>
        ) : (
          <Table>
            <THead cols={["Job", "Error", "Attempts", "Failed", ""]} />
            <tbody>
              {s.failed_jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <strong>{j.name}</strong>
                    <span className="table-sub mono">{j.id}</span>
                  </td>
                  <td style={{ maxWidth: 420 }}>{j.error}</td>
                  <td className="num">{j.attempts}</td>
                  <td>
                    <RelativeTime iso={j.failed_at} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => retry(j)}>
                      <RotateCcw /> Retry
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </SectionCard>

      <SectionCard title="Agents" detail="Sensor agents and their versions" flush>
        <Table>
          <THead
            cols={[
              "Agent",
              "Host",
              "Version",
              "Last heartbeat",
              { label: "Buffered", num: true },
              { label: "Dropped", num: true },
            ]}
          />
          <tbody>
            {s.agents.map((a) => (
              <tr key={a.id}>
                <td className="mono">
                  <strong>{a.id}</strong>
                </td>
                <td>{a.host}</td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="mono">{a.version}</span>
                    {a.outdated ? (
                      <Pill tone="drift" title={`Latest is ${a.latest}`}>
                        outdated
                      </Pill>
                    ) : (
                      <Pill tone="ok">current</Pill>
                    )}
                  </span>
                </td>
                <td>
                  <RelativeTime iso={a.last_heartbeat_at} />
                </td>
                <td className="num">{a.buffer}</td>
                <td className="num">{a.dropped}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </SectionCard>
      <div className="dim row" style={{ gap: 6, fontSize: 12 }}>
        <Radio size={13} /> {s.stream_connections} browser stream connections open.
      </div>
    </div>
  );
}
