"use client";
import {
  ArrowLeft,
  Bot,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Coins,
  Download,
  FileText,
  Flag,
  KeyRound,
  Loader2,
  Network,
  ShieldBan,
  ShieldCheck,
  Sparkles,
  User,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { KillChain } from "@/components/killchain";
import {
  Card,
  Chip,
  Dropdown,
  EmptyState,
  ErrorState,
  HashChip,
  LabelPill,
  PageLoading,
  Pill,
  RuleChip,
  SeverityPill,
  Skeleton,
  StatusPill,
  TechChip,
} from "@/components/ui";
import { BlockModal, describeEvent, RelativeTime, UnblockModal } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { EVENT_LABEL, eventTone, ruleName, SEVERITY, STAGE_LABEL } from "@/lib/labels";
import { storeActions } from "@/lib/store";
import { toast } from "@/lib/toast";
import { clock, csvEscape, downloadBlob, duration, fmtNum, stamp } from "@/lib/utils";

function srcOf(e) {
  if (!e.is_decoy) return "app";
  const id = e.decoy_id || e.dst_service || "";
  if (id.startsWith("ssh")) return "ssh";
  if (id.startsWith("web")) return "web";
  if (id.startsWith("redis")) return "redis";
  return id.split(":")[0] || "decoy";
}

function buildTimeline(events, triggerMap) {
  const out = [];
  events.forEach((e, idx) => {
    const n = idx + 1;
    const prev = out[out.length - 1];
    const groupable = e.event_type === "auth.attempt" && e.outcome === "failure";
    if (groupable && prev && prev.group) {
      prev.items.push({ e, n });
      return;
    }
    out.push({ key: e.id, group: groupable, items: [{ e, n }] });
  });
  return out.map((g) => ({ ...g, trigger: g.items.map((i) => triggerMap[i.e.id]).find(Boolean) }));
}

function Timeline({ events, triggerMap }) {
  const rows = useMemo(() => buildTimeline(events, triggerMap), [events, triggerMap]);
  if (!rows.length)
    return (
      <EmptyState icon={FileText} title="No events loaded">
        The event chain for this incident could not be loaded.
      </EmptyState>
    );
  return (
    <ol className="ds-timeline">
      {rows.map((g) => {
        const first = g.items[0].e;
        const multi = g.items.length > 1;
        const last = g.items[g.items.length - 1].e;
        return (
          <li key={g.key} data-tone={g.trigger ? "bad" : eventTone(first)} id={`ev-${first.id}`}>
            {g.items.slice(1).map((i) => (
              <span key={i.e.id} id={`ev-${i.e.id}`} />
            ))}
            <div className="tl-head">
              <span className="tl-time">{clock(first.occurred_at)}</span>
              <span className="tl-src">{srcOf(first)}</span>
              <span className="tl-body">
                {multi
                  ? `${g.items.length} failed logins in ${duration(first.occurred_at, last.occurred_at)}`
                  : EVENT_LABEL[first.event_type] || first.event_type}
              </span>
              {first.stage ? (
                <Chip>{STAGE_LABEL[first.stage]}</Chip>
              ) : first.is_decoy ? null : (
                <Chip op="ip">real app</Chip>
              )}
            </div>
            <div className="tl-cmd" title={describeEvent(first)}>
              {multi
                ? g.items
                    .map((i) => `${i.e.fields.username}/${i.e.fields.password_masked}`)
                    .join("  ")
                : describeEvent(first)}
            </div>
            {g.trigger ? (
              <div className="tl-trigger">
                <Pill tone="bad" solid>
                  {g.trigger}
                </Pill>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function Ledger({ inc, events }) {
  const idxOf = useMemo(() => Object.fromEntries(events.map((e, i) => [e.id, i + 1])), [events]);
  let run = 0;
  const raw = inc.detections.reduce((n, d) => n + d.points, 0);
  const sev = SEVERITY[inc.severity];
  const floors = inc.detections.filter((d) => d.floor).map((d) => d.rule_id);
  const raised = floors.length > 0 && Math.min(100, raw) < inc.score;
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="dim" style={{ fontWeight: 600 }}>
          Score
        </span>
        <span className="spacer" />
        <span className="num">
          <strong style={{ fontSize: 14 }}>{inc.score}</strong>
          <span className="dim"> / 100</span>
        </span>
      </div>
      <div
        className="score-meter"
        role="meter"
        aria-valuenow={inc.score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Incident score"
      >
        <span style={{ width: `${Math.min(100, inc.score)}%` }} />
      </div>
      <div className="score-marks">
        <span>0 · Low</span>
        <span>40 · Medium</span>
        <span>50 · High</span>
        <span>75+ · Critical</span>
      </div>

      <div className="ledger" style={{ marginTop: 10 }}>
        {inc.detections.map((d, i) => {
          run += d.points;
          const shown = Math.min(100, run);
          const evIdx = d.evidence_event_ids.map((id) => idxOf[id]).filter(Boolean);
          return (
            <div
              className={`ledger-row${d.floor ? " is-floor" : ""}${d.points === 0 ? " is-signal" : ""}`}
              key={`${d.rule_id}-${i}`}
            >
              <div
                className="ledger-pts"
                title={
                  d.points === 0
                    ? "Label signal or tag: adds no points"
                    : `Running total ${run}${run > 100 ? " (capped at 100)" : ""}`
                }
              >
                {d.points > 0 ? `+${d.points}` : "0"}
                <small>
                  Σ {shown}
                  {run > 100 ? "*" : ""}
                </small>
              </div>
              <div>
                <div className="ledger-title">
                  <span>{ruleName(d.rule_id)}</span>
                  <RuleChip id={d.rule_id} />
                  {d.floor ? (
                    <Pill tone="bad" solid>
                      Floor {SEVERITY[d.floor].label.toUpperCase()}
                    </Pill>
                  ) : null}
                  {d.points === 0 ? <Pill tone="halted">no points</Pill> : null}
                </div>
                <div className="ledger-reason">{d.reason}</div>
                <div className="ledger-evidence">
                  {evIdx.length ? (
                    <>
                      <span>Evidence</span>
                      {evIdx.slice(0, 6).map((n) => (
                        <a key={n} className="chip" href={`#ev-${events[n - 1].id}`}>
                          ev #{n}
                        </a>
                      ))}
                      {evIdx.length > 6 ? <span>+{evIdx.length - 6}</span> : null}
                    </>
                  ) : null}
                  {d.techniques.length ? (
                    <span className="row" style={{ gap: 4, marginLeft: evIdx.length ? 6 : 0 }}>
                      {d.techniques.map((t) => (
                        <TechChip key={t.id} id={t.id} link={false} />
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div
        className="reason-box"
        data-tone={
          inc.severity === "critical" ? "bad" : inc.severity === "high" ? "drift" : undefined
        }
        style={{ marginTop: 12 }}
      >
        <strong>
          {raw} raw points{raw > 100 ? " · capped at 100*" : ""}
        </strong>
        {raised ? (
          <>
            {" "}
            {"→"} score raised to {inc.score} by the {sev.label.toUpperCase()} floor
          </>
        ) : null}
        {floors.length && !raised ? (
          <>
            {" "}
            · floor {sev.label.toUpperCase()} from {floors.join(", ")}
          </>
        ) : null}
        {" → "}
        <strong>{sev.label.toUpperCase()}</strong>, label <strong>{inc.label}</strong>.
        <div className="dim" style={{ marginTop: 3, fontSize: 12 }}>
          {raw > 100 ? "* marks detections scored past the 100-point cap. " : ""}
          Points are additive and deterministic. The AI summary only narrates this ledger; it never
          changes the score.
        </div>
      </div>
    </div>
  );
}

function AttackerCard({ inc, attacker, events }) {
  const cad = attacker?.cadence;
  const assets = [
    ...new Set(events.filter((e) => !e.is_decoy && e.fields?.asset).map((e) => e.fields.asset)),
  ];
  return (
    <Card
      title="Attacker profile"
      right={
        attacker ? (
          <Link href={`/attackers/${attacker.id}`} className="btn btn-sm btn-ghost">
            Full profile
          </Link>
        ) : null
      }
    >
      <dl className="ds-facts">
        <div>
          <dt>Source</dt>
          <dd className="mono">{inc.src_ip}</dd>
        </div>
        <div>
          <dt>Cadence</dt>
          <dd>
            {cad ? (
              <Pill tone={cad === "human" ? "bad" : "drift"} icon={cad === "human" ? User : Bot}>
                {cad === "human" ? "Human" : cad === "bot" ? "Bot" : "Unknown"}
              </Pill>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{attacker ? attacker.session_count : "—"}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{attacker ? fmtNum(attacker.event_count) : fmtNum(inc.event_count)}</dd>
        </div>
        <div>
          <dt>Client banner</dt>
          <dd className="mono">{attacker?.fingerprints?.client_banner || "—"}</dd>
        </div>
        <div>
          <dt>Origin</dt>
          <dd>{attacker?.fingerprints?.country || "—"}</dd>
        </div>
      </dl>
      <div className="ds-section" style={{ marginTop: 14 }}>
        <h3>Decoys touched</h3>
        <div className="row-wrap" style={{ gap: 6 }}>
          {(attacker?.decoys_touched || []).map((d) => (
            <Pill key={d} tone="cache" icon={Network}>
              {d}
            </Pill>
          ))}
          {assets.map((a) => (
            <Pill key={a} tone="bad" icon={Coins}>
              {a} (real)
            </Pill>
          ))}
          {!attacker ? <Skeleton w={160} /> : null}
        </div>
      </div>
    </Card>
  );
}

function EvidenceCard({ attacker, events }) {
  const [more, setMore] = useState(false);
  const cmds = [...new Set(events.filter((e) => e.fields?.command).map((e) => e.fields.command))];
  const creds = events
    .filter((e) => e.event_type === "auth.attempt")
    .map((e) => ({
      k: e.id,
      text: `${e.fields.username} / ${e.fields.password_masked ?? "•••"}`,
      ok: e.outcome === "success",
      n: e.count,
    }));
  const files = [
    ...new Set(events.filter((e) => e.fields?.file_name).map((e) => e.fields.file_name)),
  ];
  const shown = more ? cmds : cmds.slice(0, 5);
  return (
    <Card
      title="Commands, credentials, files"
      sub="Attacker-supplied text. Rendered as data, never executed."
    >
      <div className="detail-stack" style={{ gap: 14 }}>
        <div className="ds-section">
          <h3>Commands run ({cmds.length})</h3>
          {cmds.length === 0 ? (
            <span className="dim">No shell commands.</span>
          ) : (
            <ul className="ds-list">
              {shown.map((c) => (
                <li key={c}>
                  <code
                    className="code"
                    style={{ padding: "2px 8px", maxWidth: "100%", overflowX: "auto" }}
                  >
                    {c.length > 90 && !more ? `${c.slice(0, 90)}…` : c}
                  </code>
                </li>
              ))}
            </ul>
          )}
          {cmds.length > 5 ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setMore(!more)}
            >
              {more ? (
                <>
                  <ChevronUp /> Show less
                </>
              ) : (
                <>
                  <ChevronDown /> Show {cmds.length - 5} more
                </>
              )}
            </button>
          ) : null}
        </div>
        <div className="ds-section">
          <h3>Credentials tried (masked)</h3>
          <div className="row-wrap" style={{ gap: 6 }}>
            {creds.length ? (
              creds.slice(0, 12).map((c) => (
                <span
                  key={c.k}
                  className="chip"
                  data-op={c.ok ? "rule" : undefined}
                  title={c.ok ? "Accepted" : "Rejected"}
                >
                  {c.text}
                  {c.n > 1 ? ` ×${c.n}` : ""} {c.ok ? "✔" : "✘"}
                </span>
              ))
            ) : (
              <span className="dim">None.</span>
            )}
          </div>
        </div>
        <div className="ds-section">
          <h3>Files touched</h3>
          <div className="row-wrap" style={{ gap: 6 }}>
            {files.length ? (
              files.map((f) => <Chip key={f}>{f}</Chip>)
            ) : (
              <span className="dim">None.</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// Primary actions, pinned below the top bar so Block/Export/Resolve are always one
// click away — never buried under the AI summary (IMPR P1).
function IncidentActions({
  inc,
  blocked,
  busy,
  onBlock,
  onUnblock,
  onExport,
  onAck,
  onResolve,
  onFalsePositive,
}) {
  const isOpen = inc.status === "open";
  const closed = inc.status === "resolved" || inc.status === "false_positive";
  return (
    <div className="incident-actions" role="group" aria-label="Incident actions">
      {blocked ? (
        <>
          <Pill
            tone={blocked.status === "applied" ? "ok" : "drift"}
            icon={blocked.status === "applied" ? ShieldCheck : Loader2}
            large
          >
            {blocked.status === "applied"
              ? blocked.total_sensors
                ? `Blocked · applied on ${blocked.applied_sensors}/${blocked.total_sensors} sensors`
                : "Blocked · enforced"
              : "Block pending… pushing to sensors"}
          </Pill>
          <button type="button" className="btn" onClick={onUnblock}>
            <ShieldCheck /> Unblock
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-danger" onClick={onBlock} disabled={busy}>
          <ShieldBan /> Block source · 24 h
        </button>
      )}
      <Dropdown
        label="Export IOCs"
        icon={Download}
        items={[
          { label: "JSON", onClick: () => onExport("json") },
          { label: "CSV", onClick: () => onExport("csv") },
          { label: "STIX 2.1", onClick: () => onExport("stix") },
        ]}
      />
      <span className="spacer" />
      {isOpen ? (
        <button type="button" className="btn" onClick={onAck} disabled={busy}>
          <CheckCheck /> Acknowledge
        </button>
      ) : null}
      {!closed ? (
        <Dropdown
          label="Resolve"
          icon={CircleCheck}
          items={[
            { label: "Resolve incident", icon: CircleCheck, onClick: onResolve },
            { label: "Mark false positive", icon: Flag, onClick: onFalsePositive },
          ]}
        />
      ) : (
        <StatusPill status={inc.status} />
      )}
    </div>
  );
}

function AiBand({ inc, onNarrate, narrating }) {
  const ai = inc.ai_summary;
  const assessment = inc.ai_assessment;
  const pending = !ai && (inc.ai_status === "pending" || !inc.ai_status);
  const generatingSummary = !!ai?.is_fallback && ["pending", "generating"].includes(inc.ai_status);
  const generatingAssessment = inc.ai_status === "generating" && !assessment;
  const failed = !ai && ["failed", "error"].includes(inc.ai_status);
  return (
    <section className="ds-card ai-band" aria-label="AI summary">
      <div
        className="reason-box"
        data-tone={inc.severity === "critical" ? "bad" : undefined}
        style={{ border: 0, padding: 0, background: "none" }}
      >
        {assessment ? (
          <div className="reason-box" style={{ marginBottom: 16 }}>
            <div className="row" style={{ marginBottom: 8, gap: 10 }}>
              <span className="ai-label"><Sparkles size={13} /> AI-flagged novel behaviour</span>
              <Pill tone="brand">Advisory</Pill>
              <SeverityPill severity={assessment.suggested_severity} />
              <span className="dim" style={{ fontSize: 12 }}>
                Suggested {assessment.suggested_label} · {Math.round(assessment.confidence * 100)}% confidence · deterministic score unchanged
              </span>
            </div>
            <p style={{ fontWeight: 650 }}>{assessment.novel_behaviour}</p>
            <p className="dim">{assessment.rationale}</p>
            {assessment.suggested_techniques.length ? (
              <div className="row-wrap" style={{ gap: 6, marginTop: 8 }}>
                {assessment.suggested_techniques.map((t) => <Chip key={t}>{t}</Chip>)}
              </div>
            ) : null}
            {assessment.recommended_actions.length ? (
              <div className="row-wrap" style={{ gap: 6, marginTop: 8 }}>
                {assessment.recommended_actions.map((a) => <Chip key={a}>{a.replaceAll("_", " ")}</Chip>)}
              </div>
            ) : null}
          </div>
        ) : generatingAssessment ? (
          <p className="dim" style={{ marginBottom: 12 }}>AI is assessing uncovered activity. Its result is advisory and cannot change the rule score or trigger containment.</p>
        ) : null}
        <div className="row" style={{ marginBottom: 8, gap: 10 }}>
          <span className="ai-label">
            <Sparkles size={13} /> AI summary
          </span>
          {ai ? (
            ai.is_fallback ? (
              <Pill
                tone="halted"
                title="LLM unavailable or declined: this summary was filled from the detection ledger by a deterministic template."
              >
                Template
              </Pill>
            ) : (
              <Pill tone="brand">AI-generated</Pill>
            )
          ) : pending ? (
            <Pill tone="drift" icon={Loader2}>
              Generating…
            </Pill>
          ) : (
            <Pill tone="halted">Unavailable</Pill>
          )}
          {generatingSummary ? <Pill tone="drift" icon={Loader2}>LLM generating</Pill> : null}
          {generatingAssessment ? <Pill tone="drift" icon={Loader2}>Assessing novel activity</Pill> : null}
          {inc.ai_status === "error" ? <Pill tone="halted">Advisory assessment unavailable</Pill> : null}
          <span className="dim" style={{ fontSize: 12 }}>
            Narrates the ledger, never changes the score.
          </span>
          {(ai?.is_fallback || failed) && onNarrate ? (
            <button type="button" className="btn btn-sm" disabled={narrating} onClick={onNarrate}>
              {narrating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              {narrating ? "Generating…" : "Try AI summary again"}
            </button>
          ) : null}
        </div>
        {ai ? (
          <div className="grid-2" style={{ gap: 18 }}>
            <div className="col" style={{ gap: 6 }}>
              <div style={{ fontWeight: 650, fontSize: 14.5, lineHeight: 1.35 }}>{ai.headline}</div>
              <p>{ai.what_happened}</p>
              {ai.why_it_matters ? (
                <p className="dim">
                  <strong style={{ color: "var(--text)" }}>Why it matters:</strong>{" "}
                  {ai.why_it_matters}
                </p>
              ) : null}
            </div>
            <div>
              <div
                className="field-label"
                style={{
                  marginBottom: 6,
                  fontSize: 11.5,
                  fontWeight: 650,
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                  color: "var(--text-dim)",
                }}
              >
                Recommended actions
              </div>
              <ul className="ds-list" style={{ gap: 7 }}>
                {ai.recommended_actions.map((a, i) => (
                  <li key={i}>
                    <span className="chip" style={{ flex: "none" }}>
                      {i + 1}
                    </span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : pending ? (
          <div className="col" style={{ gap: 8 }}>
            <Skeleton w="70%" h={16} />
            <Skeleton w="95%" />
            <Skeleton w="88%" />
            <span className="dim" style={{ fontSize: 12 }}>
              The deterministic evidence on this page is complete; the narrative arrives in a few
              seconds, or a template is used if the LLM is down.
            </span>
          </div>
        ) : (
          <p className="dim">
            {failed
              ? "Narration failed for this incident. The ledger above is the source of truth."
              : "No summary available."}
          </p>
        )}
      </div>
    </section>
  );
}

function AuditTrail({ rows, number, incidentId }) {
  const mine = rows
    .filter((r) => r.target.includes(`#${number}`) || r.metadata?.incident_id === incidentId)
    .slice(0, 6);
  return (
    <Card title="This incident's audit trail" sub="One click to act, one row in the audit log">
      {mine.length === 0 ? (
        <span className="dim">
          No actions taken yet. Block, acknowledge or resolve and the row appears here.
        </span>
      ) : (
        <ul className="ds-list">
          {mine.map((r) => (
            <li key={r.id} style={{ flexWrap: "wrap" }}>
              <span className="mono dim" style={{ minWidth: 112 }}>
                {stamp(r.at)}
              </span>
              <Pill tone={r.action === "block_ip" ? "bad" : "cache"}>{r.action}</Pill>
              <span className="dim">{r.actor}</span>
              <span className="faint mono truncate" style={{ maxWidth: 260 }}>
                {JSON.stringify(r.metadata)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function exportIocs(iocs, fmt, number) {
  const rows = iocs.indicators || [];
  if (fmt === "json")
    return downloadBlob(
      `incident-${number}-iocs.json`,
      JSON.stringify(iocs, null, 2),
      "application/json",
    );
  if (fmt === "csv") {
    const lines = [
      "type,value,first_seen,last_seen,context",
      ...rows.map((r) =>
        [r.type, r.value, r.first_seen, r.last_seen, r.context].map(csvEscape).join(","),
      ),
    ];
    return downloadBlob(`incident-${number}-iocs.csv`, lines.join("\n"), "text/csv");
  }
  const now = new Date().toISOString();
  const pat = (r) =>
    r.type === "ipv4"
      ? `[ipv4-addr:value = '${r.value}']`
      : r.type === "url"
        ? `[url:value = '${r.value}']`
        : `[x-lxs:${r.type} = '${String(r.value).replace(/'/g, "\\'")}']`;
  const bundle = {
    type: "bundle",
    id: `bundle--${crypto.randomUUID()}`,
    objects: rows.map((r) => ({
      type: "indicator",
      spec_version: "2.1",
      id: `indicator--${crypto.randomUUID()}`,
      created: now,
      modified: now,
      name: `${r.type}: ${r.value}`,
      description: r.context,
      pattern: pat(r),
      pattern_type: "stix",
      valid_from: r.first_seen || now,
    })),
  };
  return downloadBlob(
    `incident-${number}-iocs.stix.json`,
    JSON.stringify(bundle, null, 2),
    "application/json",
  );
}

export default function IncidentDetailPage() {
  const { id } = useParams();
  const [blockOpen, setBlockOpen] = useState(false);
  const [unblockOpen, setUnblockOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [narrating, setNarrating] = useState(false);

  const { data, error, loading, reload } = usePolling(
    async () => {
      const inc = await api.incident(id);
      const [events, attacker, blocklist, audit] = await Promise.all([
        api.incidentEvents(inc.id).catch(() => []),
        inc.attacker_id ? api.attacker(inc.attacker_id).catch(() => null) : null,
        api.blocklist(PROJECT),
        api.audit(PROJECT).catch(() => []),
      ]);
      return {
        inc,
        events: events.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at)),
        attacker,
        blocklist,
        audit,
      };
    },
    5000,
    [id],
  );

  const triggerMap = useMemo(() => {
    const m = {};
    (data?.inc.detections || [])
      .filter((d) => d.floor)
      .forEach((d) =>
        d.evidence_event_ids.forEach((eid) => {
          m[eid] = `Triggered ${SEVERITY[d.floor].label.toUpperCase()} floor · ${d.rule_id}`;
        }),
      );
    return m;
  }, [data]);

  if (loading && !data)
    return (
      <div className="ds-page">
        <PageLoading label="Loading incident…" />
      </div>
    );
  if (error && !data)
    return (
      <div className="ds-page">
        <Link
          href="/incidents"
          className="btn btn-sm btn-ghost"
          style={{ alignSelf: "flex-start" }}
        >
          <ArrowLeft /> Incident queue
        </Link>
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  const { inc, events, attacker, blocklist, audit } = data;
  const blocked =
    blocklist.find(
      (b) =>
        b.ip === inc.src_ip &&
        b.status !== "expired" &&
        (!b.expires_at || new Date(b.expires_at) > new Date()),
    ) ||
    (inc.blocked
      ? {
          id: inc.block_entry_id,
          status: "applied",
          applied_sensors: inc.blocked.applied_sensors ?? 0,
          total_sensors: inc.blocked.total_sensors ?? 0,
        }
      : null);
  const assets = [
    ...new Set(events.filter((e) => !e.is_decoy && e.fields?.asset).map((e) => e.fields.asset)),
  ];
  const token = events.find((e) => e.event_type === "honeytoken.use")?.fields?.token;
  const sev = SEVERITY[inc.severity];

  const act = async (fn, okMsg, okDesc) => {
    setBusy(true);
    try {
      await fn();
      toast(okMsg, "success", okDesc);
      storeActions.refresh();
      await reload();
      setTimeout(reload, 3200);
    } catch (e) {
      toast("Action failed", "error", e.message);
    } finally {
      setBusy(false);
    }
  };

  const doExport = async (fmt) => {
    try {
      const iocs = await api.iocs(
        PROJECT,
        inc.id,
        fmt === "csv" ? "json" : fmt === "stix" ? "json" : fmt,
      );
      exportIocs(iocs, fmt, inc.number);
      const count = iocs.indicators?.length ?? 0;
      try {
        await api.action(inc.id, { type: "export_iocs", params: { format: fmt } });
        toast(
          `Exported ${count} IOCs as ${fmt.toUpperCase()}`,
          "success",
          "Written to the audit log.",
        );
      } catch (e) {
        toast(`Exported ${count} IOCs, but the audit entry failed`, "error", e.message);
      }
    } catch (e) {
      toast("Export failed", "error", e.message);
    }
  };

  return (
    <div className="ds-page">
      <Link
        href="/incidents"
        className="btn btn-sm btn-ghost"
        style={{ alignSelf: "flex-start", marginBottom: -8 }}
      >
        <ArrowLeft /> Incident queue
      </Link>

      {/* WHO · WHAT · HOW FAR · HOW BAD */}
      <section className="ds-card hero-header" data-sev={inc.severity} aria-label="Incident header">
        <div className="row" style={{ alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="ds-title">
              <span className="ds-eyebrow" style={{ margin: 0 }}>
                Incident #{inc.number}
              </span>
              <SeverityPill severity={inc.severity} large />
              <LabelPill label={inc.label} large />
              <StatusPill status={inc.status} />
            </div>
            <h1 style={{ marginTop: 8, fontSize: 21 }}>{inc.title}</h1>
            <div className="row-wrap dim" style={{ marginTop: 8, gap: 14, fontSize: 12.5 }}>
              <span className="row" style={{ gap: 6 }}>
                Source <HashChip hash={inc.src_ip} />
              </span>
              <span>
                first <strong style={{ color: "var(--text)" }}>{clock(inc.first_event_at)}</strong>
              </span>
              <span>
                last <strong style={{ color: "var(--text)" }}>{clock(inc.last_event_at)}</strong> (
                <RelativeTime iso={inc.last_event_at} />)
              </span>
              <span>
                dwell{" "}
                <strong style={{ color: "var(--text)" }}>
                  {duration(inc.first_event_at, inc.last_event_at)}
                </strong>
              </span>
              <span>{fmtNum(inc.event_count)} events</span>
            </div>
          </div>
          <div style={{ minWidth: 150, textAlign: "right" }}>
            <div className="score-big" style={{ color: `var(--sev-${inc.severity})` }}>
              {inc.score}
              <span className="dim" style={{ fontSize: 15, fontWeight: 500 }}>
                /100
              </span>
            </div>
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
              {sev.hint}
            </div>
          </div>
        </div>

        <KillChain stages={inc.stages} severity={inc.severity} />

        <div className="row-wrap" style={{ gap: 10 }}>
          {inc.real_asset_reached ? (
            <span className="badge-callout">
              <Coins /> REAL ASSET REACHED{assets.length ? `: ${assets.join(", ")}` : ""}
            </span>
          ) : null}
          {inc.honeytoken_used ? (
            <span className="badge-callout">
              <KeyRound /> HONEYTOKEN USED{token ? <small>{token}</small> : null}
            </span>
          ) : null}
          {!inc.real_asset_reached && !inc.honeytoken_used ? (
            <Pill tone="ok" large icon={ShieldCheck}>
              Contained to decoys, no real asset touched
            </Pill>
          ) : null}
        </div>

        <div className="row-wrap" style={{ gap: 5 }} role="group" aria-label="ATT&CK techniques">
          <span className="dim" style={{ fontSize: 11.5, fontWeight: 600, marginRight: 4 }}>
            ATT&amp;CK
          </span>
          {inc.techniques.map((t) => (
            <TechChip key={t} id={t} />
          ))}
        </div>
      </section>

      <IncidentActions
        inc={inc}
        blocked={blocked}
        busy={busy}
        onBlock={() => setBlockOpen(true)}
        onUnblock={() => setUnblockOpen(true)}
        onExport={doExport}
        onAck={() =>
          act(
            () => api.patchIncident(inc.id, { status: "acknowledged" }),
            `Incident #${inc.number} acknowledged`,
            "Status updated and audited.",
          )
        }
        onResolve={() =>
          act(
            () => api.patchIncident(inc.id, { status: "resolved" }),
            `Incident #${inc.number} resolved`,
            "Moved to the Resolved tab.",
          )
        }
        onFalsePositive={() =>
          act(
            () => api.patchIncident(inc.id, { status: "false_positive" }),
            `Incident #${inc.number} marked false positive`,
            "Moved to the Resolved tab.",
          )
        }
      />

      {/* TIMELINE | WHY */}
      <div className="hero-split">
        <Card
          title="Attack timeline"
          sub={`${events.length} events, oldest first. Red marks what tipped the severity.`}
        >
          <Timeline events={events} triggerMap={triggerMap} />
        </Card>
        <Card
          title={`Why is this ${inc.severity}?`}
          sub="Every detection: rule → points → reason → evidence"
        >
          <Ledger inc={inc} events={events} />
        </Card>
      </div>

      {/* AI SUMMARY */}
      <AiBand
        inc={inc}
        narrating={narrating}
        onNarrate={async () => {
          setNarrating(true);
          try {
            await api.narrateIncident(inc.id);
            toast("AI summary queued", "success", "The incident page will update when narration finishes.");
            setTimeout(reload, 2500);
          } catch (e) {
            toast("Could not generate AI summary", "error", e.message);
          } finally {
            setNarrating(false);
          }
        }}
      />

      <div className="hero-split">
        <AttackerCard inc={inc} attacker={attacker} events={events} />
        <EvidenceCard attacker={attacker} events={events} />
      </div>

      <AuditTrail rows={audit} number={inc.number} incidentId={inc.id} />

      <BlockModal
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        ip={inc.src_ip}
        incident={inc}
        onDone={() => {
          storeActions.refresh();
          reload();
          setTimeout(reload, 3200);
        }}
      />
      <UnblockModal
        open={unblockOpen}
        onClose={() => setUnblockOpen(false)}
        ip={inc.src_ip}
        onConfirm={async () => {
          try {
            if (blocked) await api.unblock(PROJECT, blocked.id);
            toast(
              `${inc.src_ip} unblocked`,
              "success",
              "Sensors will allow it again on the next policy poll.",
            );
            await reload();
          } catch (e) {
            toast("Could not unblock", "error", e.message);
          }
        }}
      />
    </div>
  );
}
