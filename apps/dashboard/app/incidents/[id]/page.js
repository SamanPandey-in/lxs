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
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { KillChain } from "@/components/killchain";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  Dropdown,
  EmptyState,
  ErrorState,
  HashChip,
  LabelPill,
  RuleChip,
  SeverityPill,
  Skeleton,
  StatusPill,
  Tabs,
  TechList,
} from "@/components/ui";
import { BlockModal, describeEvent, RelativeTime, UnblockModal } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { EVENT_LABEL, ruleName, SEVERITY, STAGE_LABEL } from "@/lib/labels";
import { storeActions } from "@/lib/store";
import { toast } from "@/lib/toast";
import { clock, cn, csvEscape, downloadBlob, duration, fmtNum, stamp } from "@/lib/utils";

const SEV_BG = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};
const SEV_BORDER = {
  critical: "border-l-sev-critical",
  high: "border-l-sev-high",
  medium: "border-l-sev-medium",
  low: "border-l-sev-low",
};

const DETAIL_TABS = ["timeline", "ledger", "iocs"];
const TAB_LABEL = { timeline: "Timeline", ledger: "Score ledger", iocs: "IOCs & raw" };

// Everything below the sticky action bar scrolls (and receives focus) clear of it:
// 48 px topbar + ~56 px action bar ≈ scroll-mt-28 (112 px). On mobile the bar sits at the bottom.
const CLEAR_STICKY =
  "[&_a]:scroll-mt-28 [&_button]:scroll-mt-28 [&_li]:scroll-mt-28 [&_section]:scroll-mt-28 max-md:[&_a]:scroll-mb-20 max-md:[&_button]:scroll-mb-20";

function srcOf(e) {
  if (!e.is_decoy) return "app";
  const id = e.decoy_id || e.dst_service || "";
  if (id.startsWith("ssh")) return "ssh";
  if (id.startsWith("web")) return "web";
  if (id.startsWith("redis")) return "redis";
  return id.split(":")[0] || "decoy";
}

/** Score facts shared by the summary and the ledger. */
function scoreFacts(inc) {
  const raw = inc.detections.reduce((n, d) => n + d.points, 0);
  const floors = inc.detections.filter((d) => d.floor);
  const raised = floors.length > 0 && Math.min(100, raw) < inc.score;
  const top = [...inc.detections]
    .filter((d) => d.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);
  return { raw, floors, raised, top };
}

function buildTimeline(events, triggerMap) {
  const out = [];
  events.forEach((e, idx) => {
    const n = idx + 1;
    const prev = out[out.length - 1];
    const groupable = e.event_type === "auth.attempt" && e.outcome === "failure";
    if (groupable && prev?.group) {
      prev.items.push({ e, n });
      return;
    }
    out.push({ key: e.id, group: groupable, items: [{ e, n }] });
  });
  return out.map((g) => ({ ...g, trigger: g.items.map((i) => triggerMap[i.e.id]).find(Boolean) }));
}

/* ───────── Timeline: one line per event ───────── */
function Timeline({ events, triggerMap }) {
  const rows = useMemo(() => buildTimeline(events, triggerMap), [events, triggerMap]);
  if (!rows.length)
    return (
      <EmptyState icon={FileText} title="No events loaded">
        The event chain for this incident couldn't be loaded.
      </EmptyState>
    );
  return (
    <ol className="m-0 list-none p-0">
      {rows.map((g) => {
        const first = g.items[0].e;
        const last = g.items[g.items.length - 1].e;
        const multi = g.items.length > 1;
        const value = multi
          ? g.items.map((i) => `${i.e.fields.username}/${i.e.fields.password_masked}`).join("  ")
          : describeEvent(first);
        return (
          <li
            key={g.key}
            id={`ev-${first.id}`}
            className={cn(
              "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-l-2 border-b-border px-5 py-2 last:border-b-0 target:bg-muted md:flex-nowrap",
              g.trigger ? cn(SEV_BORDER[g.trigger.floor], "bg-muted/50") : "border-l-transparent",
            )}
          >
            {g.items.slice(1).map((i) => (
              <span key={i.e.id} id={`ev-${i.e.id}`} className="sr-only" />
            ))}
            <time
              dateTime={first.occurred_at}
              className="w-16 shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
            >
              {clock(first.occurred_at)}
            </time>
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{srcOf(first)}</span>
            <span
              className={cn(
                "shrink-0 text-sm",
                g.trigger || !first.is_decoy ? "font-medium text-foreground" : "text-foreground",
              )}
            >
              {multi
                ? `${g.items.length} failed logins in ${duration(first.occurred_at, last.occurred_at)}`
                : EVENT_LABEL[first.event_type] || first.event_type}
            </span>
            <span
              translate="no"
              title={value}
              className="min-w-0 basis-full truncate font-mono text-xs text-muted-foreground md:flex-1 md:basis-auto"
            >
              {value}
            </span>
            {g.trigger ? (
              <Badge
                variant="tag"
                tone={g.trigger.floor}
                title={`${g.trigger.rule} · ${ruleName(g.trigger.rule)}`}
              >
                Raised to {SEVERITY[g.trigger.floor].label}
              </Badge>
            ) : !first.is_decoy ? (
              <Badge variant="tag" tone="bad">
                Real app
              </Badge>
            ) : first.stage ? (
              <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">
                {STAGE_LABEL[first.stage]}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ───────── Score ledger ───────── */
function Ledger({ inc, events }) {
  const idxOf = useMemo(() => Object.fromEntries(events.map((e, i) => [e.id, i + 1])), [events]);
  const { raw, floors, raised } = scoreFacts(inc);
  const sev = SEVERITY[inc.severity];
  let run = 0;
  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-muted-foreground">Score</span>
          <span className="tabular-nums">
            <span className="text-base font-semibold text-foreground">{inc.score}</span>
            <span className="text-sm text-muted-foreground"> / 100</span>
          </span>
        </div>
        <div
          role="meter"
          aria-valuenow={inc.score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Incident score"
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <span
            className={cn("block h-full rounded-full", SEV_BG[inc.severity])}
            style={{ width: `${Math.min(100, inc.score)}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
          <span>0 · Low</span>
          <span>40 · Medium</span>
          <span>50 · High</span>
          <span>75+ · Critical</span>
        </div>
      </div>

      <ol className="m-0 flex list-none flex-col p-0">
        {inc.detections.map((d, i) => {
          run += d.points;
          const shown = Math.min(100, run);
          const evIdx = d.evidence_event_ids.map((eid) => idxOf[eid]).filter(Boolean);
          return (
            <li
              key={`${d.rule_id}-${i}`}
              className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 border-b border-border py-3 last:border-b-0"
            >
              <div
                className="text-right tabular-nums"
                title={
                  d.points === 0
                    ? "Label signal or tag: adds no points"
                    : `Running total ${run}${run > 100 ? " (capped at 100)" : ""}`
                }
              >
                <div
                  className={cn(
                    "text-sm font-semibold",
                    d.points ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {d.points > 0 ? `+${d.points}` : "0"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Σ {shown}
                  {run > 100 ? "*" : ""}
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-foreground">{ruleName(d.rule_id)}</span>
                  <RuleChip id={d.rule_id} />
                  {d.floor ? (
                    <Badge variant="tag" tone={d.floor}>
                      Floor: {SEVERITY[d.floor].label}
                    </Badge>
                  ) : null}
                  {d.points === 0 ? (
                    <Badge variant="tag" tone="neutral">
                      No points
                    </Badge>
                  ) : null}
                </div>
                <p className="m-0 text-sm text-muted-foreground text-pretty">{d.reason}</p>
                {evIdx.length || d.techniques.length ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    {evIdx.length ? (
                      <>
                        <span className="text-muted-foreground">Evidence</span>
                        {evIdx.slice(0, 6).map((n) => (
                          <Link
                            key={n}
                            href={`?tab=timeline#ev-${events[n - 1].id}`}
                            className="rounded-sm font-mono text-link tabular-nums underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            ev #{n}
                          </Link>
                        ))}
                        {evIdx.length > 6 ? (
                          <span className="text-muted-foreground tabular-nums">
                            +{evIdx.length - 6}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                    {d.techniques.length ? (
                      <TechList ids={d.techniques.map((t) => t.id)} link={false} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm text-foreground">
        <p className="m-0">
          <span className="font-medium tabular-nums">
            {raw} raw points{raw > 100 ? " · capped at 100*" : ""}
          </span>
          {raised ? ` → raised to ${inc.score} by the ${sev.label.toLowerCase()} floor` : ""}
          {floors.length && !raised
            ? ` · ${sev.label.toLowerCase()} floor from ${floors.map((d) => d.rule_id).join(", ")}`
            : ""}
          {" → "}
          <span className="font-medium">{sev.label}</span>, label{" "}
          <span className="font-medium">{inc.label}</span>.
        </p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          {raw > 100 ? "* marks detections scored past the 100-point cap. " : ""}
          Points are additive and deterministic. The AI summary only narrates this ledger; it never
          changes the score.
        </p>
      </div>
    </div>
  );
}

/* ───────── IOCs and raw evidence ───────── */
function Fact({ label, children, mono }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "m-0 truncate text-sm text-foreground tabular-nums",
          mono && "font-mono",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function SubHeading({ children }) {
  return (
    <h3 className="m-0 mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

function Evidence({ inc, attacker, events }) {
  const [allCmds, setAllCmds] = useState(false);
  const [raw, setRaw] = useState(false);
  const cad = attacker?.cadence;
  const assets = [
    ...new Set(events.filter((e) => !e.is_decoy && e.fields?.asset).map((e) => e.fields.asset)),
  ];
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
  return (
    <div className="flex flex-col gap-6 px-5 py-4">
      <section aria-labelledby="ev-attacker">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3
            id="ev-attacker"
            className="m-0 text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            Attacker
          </h3>
          {attacker ? (
            <Button
              variant="ghost"
              size="sm"
              render={<Link href={`/attackers/${attacker.id}`} />}
              nativeButton={false}
            >
              Full profile
            </Button>
          ) : null}
        </div>
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Source" mono>
            <span translate="no">{inc.src_ip}</span>
          </Fact>
          <Fact label="Cadence">
            {cad ? (
              <Badge variant="tag" tone="neutral">
                {cad === "human" ? <User aria-hidden /> : <Bot aria-hidden />}
                {cad === "human" ? "Human" : cad === "bot" ? "Bot" : "Unknown"}
              </Badge>
            ) : (
              "—"
            )}
          </Fact>
          <Fact label="Sessions">{attacker ? fmtNum(attacker.session_count) : "—"}</Fact>
          <Fact label="Events">
            {attacker ? fmtNum(attacker.event_count) : fmtNum(inc.event_count)}
          </Fact>
          <Fact label="Client banner" mono>
            {attacker?.fingerprints?.client_banner || "—"}
          </Fact>
          <Fact label="Origin">{attacker?.fingerprints?.country || "—"}</Fact>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Touched</span>
          {(attacker?.decoys_touched || []).map((d) => (
            <Badge key={d} variant="tag" tone="info">
              <Network aria-hidden />
              {d}
            </Badge>
          ))}
          {assets.map((a) => (
            <Badge key={a} variant="tag" tone="bad">
              <Coins aria-hidden />
              {a} (real asset)
            </Badge>
          ))}
          {!attacker ? <Skeleton w={160} h={20} /> : null}
        </div>
      </section>

      <section aria-labelledby="ev-cmds">
        <SubHeading>
          <span id="ev-cmds">
            Commands run <span className="tabular-nums">({cmds.length})</span>
          </span>
        </SubHeading>
        {cmds.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No shell commands.</p>
        ) : (
          <>
            <p className="m-0 mb-2 text-xs text-muted-foreground">
              Attacker-supplied text. Rendered as data, never executed.
            </p>
            <CodeBlock
              label="Commands run"
              value={(allCmds ? cmds : cmds.slice(0, 5)).map((c) => `$ ${c}`).join("\n")}
            />
            {cmds.length > 5 ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1"
                aria-expanded={allCmds}
                onClick={() => setAllCmds(!allCmds)}
              >
                {allCmds ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
                {allCmds ? "Show fewer" : `Show all ${cmds.length} commands`}
              </Button>
            ) : null}
          </>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="ev-creds">
          <SubHeading>
            <span id="ev-creds">Credentials tried (masked)</span>
          </SubHeading>
          {creds.length ? (
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
              {creds.slice(0, 12).map((c) => (
                <li key={c.k} className="font-mono text-xs text-foreground" translate="no">
                  {c.text}
                  {c.n > 1 ? <span className="tabular-nums"> ×{c.n}</span> : null}{" "}
                  <span className={c.ok ? "text-ok" : "text-muted-foreground"}>
                    {c.ok ? "✔ accepted" : "✘ rejected"}
                  </span>
                </li>
              ))}
              {creds.length > 12 ? (
                <li className="text-xs text-muted-foreground tabular-nums">
                  +{creds.length - 12} more
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">None.</p>
          )}
        </section>
        <section aria-labelledby="ev-files">
          <SubHeading>
            <span id="ev-files">Files touched</span>
          </SubHeading>
          {files.length ? (
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
              {files.map((f) => (
                <li key={f} className="font-mono text-xs text-foreground" translate="no">
                  {f}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">None.</p>
          )}
        </section>
      </div>

      <section aria-labelledby="ev-raw">
        <div className="flex items-center justify-between gap-3">
          <SubHeading>
            <span id="ev-raw">
              Raw events <span className="tabular-nums">({events.length})</span>
            </span>
          </SubHeading>
          <Button variant="ghost" size="sm" aria-expanded={raw} onClick={() => setRaw(!raw)}>
            {raw ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            {raw ? "Hide raw events" : "Show raw events"}
          </Button>
        </div>
        {raw ? <CodeBlock label="Raw events (JSON)" value={events} /> : null}
      </section>
    </div>
  );
}

/* ───────── Actions (sticky) ───────── */
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
    <div
      role="toolbar"
      aria-label="Incident actions"
      className="z-10 -mx-4 flex min-w-0 flex-wrap items-center gap-2 border-border bg-background px-4 py-2 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:mx-0 max-md:border-t md:sticky md:top-12 md:-mx-6 md:border-b md:px-6"
    >
      {blocked ? (
        <>
          <Badge variant="status" tone={blocked.status === "applied" ? "ok" : "warn"}>
            {blocked.status === "applied"
              ? blocked.total_sensors
                ? `Blocked · applied on ${blocked.applied_sensors}/${blocked.total_sensors} sensors`
                : "Blocked · enforced"
              : "Block pending · pushing to sensors…"}
          </Badge>
          <Button variant="outline" onClick={onUnblock}>
            <ShieldCheck aria-hidden /> Unblock…
          </Button>
        </>
      ) : (
        <Button variant="destructive" onClick={onBlock} disabled={busy}>
          <ShieldBan aria-hidden /> Block source…
        </Button>
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
      <span className="flex-1" />
      {isOpen ? (
        <Button variant="outline" onClick={onAck} disabled={busy}>
          <CheckCheck aria-hidden /> Acknowledge
        </Button>
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

/* ───────── Summary: AI narrative + why this severity ───────── */
function AiStatus({ inc, ai, pending, generatingSummary, generatingAssessment }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {ai ? (
        ai.is_fallback ? (
          <Badge
            variant="outline"
            title="LLM unavailable or declined: this summary was filled from the detection ledger by a deterministic template."
          >
            Template
          </Badge>
        ) : (
          <Badge variant="tag" tone="brand">
            <Sparkles aria-hidden /> AI-generated
          </Badge>
        )
      ) : pending ? (
        <Badge variant="tag" tone="warn">
          <Loader2 aria-hidden className="motion-safe:animate-spin" /> Generating…
        </Badge>
      ) : (
        <Badge variant="tag" tone="neutral">
          Unavailable
        </Badge>
      )}
      {generatingSummary ? (
        <Badge variant="tag" tone="warn">
          <Loader2 aria-hidden className="motion-safe:animate-spin" /> LLM generating…
        </Badge>
      ) : null}
      {generatingAssessment ? (
        <Badge variant="tag" tone="warn">
          <Loader2 aria-hidden className="motion-safe:animate-spin" /> Assessing novel activity…
        </Badge>
      ) : null}
      {inc.ai_status === "error" ? (
        <Badge variant="tag" tone="neutral">
          Advisory assessment unavailable
        </Badge>
      ) : null}
    </span>
  );
}

function Summary({ inc, onNarrate, narrating }) {
  const ai = inc.ai_summary;
  const assessment = inc.ai_assessment;
  const pending = !ai && (inc.ai_status === "pending" || !inc.ai_status);
  const generatingSummary = !!ai?.is_fallback && ["pending", "generating"].includes(inc.ai_status);
  const generatingAssessment = inc.ai_status === "generating" && !assessment;
  const failed = !ai && ["failed", "error"].includes(inc.ai_status);
  const { raw, floors, raised, top } = scoreFacts(inc);
  const sev = SEVERITY[inc.severity];
  return (
    <Card
      title="Summary"
      right={
        <AiStatus
          inc={inc}
          ai={ai}
          pending={pending}
          generatingSummary={generatingSummary}
          generatingAssessment={generatingAssessment}
        />
      }
    >
      <div className="flex flex-col gap-5">
        {assessment ? (
          <div className="rounded-lg bg-muted/50 px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Sparkles className="size-4 text-primary" aria-hidden /> AI-flagged novel behaviour
              </span>
              <Badge variant="outline">Advisory</Badge>
              <SeverityPill severity={assessment.suggested_severity} />
              <span className="text-xs text-muted-foreground tabular-nums">
                Suggested {assessment.suggested_label} · {Math.round(assessment.confidence * 100)}%
                confidence · deterministic score unchanged
              </span>
            </div>
            <p className="m-0 text-sm font-medium text-foreground">{assessment.novel_behaviour}</p>
            <p className="m-0 mt-1 text-sm text-muted-foreground">{assessment.rationale}</p>
            {assessment.suggested_techniques.length ? (
              <TechList ids={assessment.suggested_techniques} link={false} className="mt-2" />
            ) : null}
            {assessment.recommended_actions.length ? (
              <ul className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0">
                {assessment.recommended_actions.map((a) => (
                  <li key={a}>
                    <Badge variant="tag" tone="neutral">
                      {a.replaceAll("_", " ")}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : generatingAssessment ? (
          <p className="m-0 text-sm text-muted-foreground">
            AI is assessing uncovered activity. Its result is advisory and can't change the rule
            score or trigger containment.
          </p>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-2">
            {ai ? (
              <>
                <p className="m-0 text-base font-medium text-foreground text-balance">
                  {ai.headline}
                </p>
                <p className="m-0 max-w-[70ch] text-sm text-foreground text-pretty">
                  {ai.what_happened}
                </p>
                {ai.why_it_matters ? (
                  <p className="m-0 max-w-[70ch] text-sm text-muted-foreground text-pretty">
                    <span className="font-medium text-foreground">Why it matters:</span>{" "}
                    {ai.why_it_matters}
                  </p>
                ) : null}
              </>
            ) : pending ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                <Skeleton w="70%" h={16} />
                <Skeleton w="95%" />
                <Skeleton w="88%" />
                <span className="text-xs text-muted-foreground">
                  The evidence on this page is complete. The narrative arrives in a few seconds, or a
                  template is used if the LLM is down.
                </span>
              </div>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">
                {failed
                  ? "Narration failed for this incident. The score ledger is the source of truth."
                  : "No summary available."}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Narrates the ledger, never changes the score.
              </span>
              {(ai?.is_fallback || failed) && onNarrate ? (
                <Button variant="outline" size="sm" loading={narrating} onClick={onNarrate}>
                  <Sparkles aria-hidden /> Try AI summary again
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {ai?.recommended_actions?.length ? (
              <div>
                <SubHeading>Recommended actions</SubHeading>
                <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm text-foreground marker:text-muted-foreground">
                  {ai.recommended_actions.map((a, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered, static per render
                    <li key={i}>{a}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            <div>
              <SubHeading>Why {sev.label.toLowerCase()}</SubHeading>
              <p className="m-0 text-sm text-foreground tabular-nums">
                {raw} points from {inc.detections.length} detection
                {inc.detections.length === 1 ? "" : "s"}
                {raised
                  ? `, raised to ${inc.score} by the ${sev.label.toLowerCase()} floor`
                  : floors.length
                    ? `, with a ${sev.label.toLowerCase()} floor`
                    : ""}
                .
              </p>
              {top.length ? (
                <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0 text-sm">
                  {top.map((d, i) => (
                    <li key={`${d.rule_id}-${i}`} className="flex min-w-0 items-baseline gap-2">
                      <span className="w-8 shrink-0 text-right font-medium tabular-nums">
                        +{d.points}
                      </span>
                      <span className="truncate text-muted-foreground">{ruleName(d.rule_id)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Link
                href="?tab=ledger#detail-tabs"
                className="mt-2 inline-block rounded-sm text-sm text-link underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Open score ledger
              </Link>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ───────── Audit trail ───────── */
function AuditTrail({ rows, number, incidentId }) {
  const mine = rows
    .filter((r) => r.target.includes(`#${number}`) || r.metadata?.incident_id === incidentId)
    .slice(0, 6);
  return (
    <Card title="Audit trail" sub="Every action on this incident" flush>
      {mine.length === 0 ? (
        <p className="m-0 px-5 pb-5 text-sm text-muted-foreground">
          No actions yet. Block, acknowledge or resolve and the entry appears here.
        </p>
      ) : (
        <ul className="m-0 list-none border-t border-border p-0">
          {mine.map((r) => (
            <li
              key={r.id}
              className="flex min-w-0 items-center gap-3 border-b border-border px-5 py-2 last:border-b-0"
            >
              <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                {stamp(r.at)}
              </span>
              <Badge variant="tag" tone={r.action === "block_ip" ? "bad" : "info"}>
                {r.action.replaceAll("_", " ")}
              </Badge>
              <span className="shrink-0 text-sm text-foreground">{r.actor}</span>
              <span
                className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:inline"
                title={JSON.stringify(r.metadata)}
              >
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

function BackLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 self-start"
      render={<Link href="/incidents" />}
      nativeButton={false}
    >
      <ArrowLeft aria-hidden /> Incidents
    </Button>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-live="polite" className="ds-page">
      <span className="sr-only">Loading incident</span>
      <Skeleton h={28} w={120} />
      <Card>
        <div className="flex flex-col gap-3">
          <Skeleton h={32} w="min(560px, 80%)" />
          <Skeleton h={20} w={280} />
          <Skeleton h={36} w="min(640px, 100%)" />
        </div>
      </Card>
      <Card>
        <div className="flex flex-col gap-2">
          <Skeleton h={16} w="60%" />
          <Skeleton w="95%" />
          <Skeleton w="88%" />
        </div>
      </Card>
    </div>
  );
}

function IncidentDetail() {
  const { id } = useParams();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = DETAIL_TABS.includes(sp.get("tab")) ? sp.get("tab") : "timeline";
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

  // Event id → the severity floor it triggered (highlighted in the timeline).
  const triggerMap = useMemo(() => {
    const m = {};
    for (const d of data?.inc.detections || []) {
      if (!d.floor) continue;
      for (const eid of d.evidence_event_ids) m[eid] = { floor: d.floor, rule: d.rule_id };
    }
    return m;
  }, [data]);

  const inc = data?.inc;
  useEffect(() => {
    if (inc) document.title = `Incident #${inc.number} · ${SEVERITY[inc.severity]?.label} · LXS`;
  }, [inc]);

  if (loading && !data) return <DetailSkeleton />;
  if (error && !data)
    return (
      <div className="ds-page">
        <BackLink />
        <Card>
          <ErrorState error={error} onRetry={reload} what="this incident" />
        </Card>
      </div>
    );

  const { events, attacker, blocklist, audit } = data;
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
  const reached = inc.stages.length;

  const setTab = (v) => {
    const next = new URLSearchParams(sp.toString());
    if (v === "timeline") next.delete("tab");
    else next.set("tab", v);
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

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
    <div className="ds-page max-md:pb-16">
      <BackLink />

      {/* What · how bad · key facts */}
      <Card>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm text-muted-foreground tabular-nums">
              Incident #{inc.number}
            </span>
            <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em] text-balance text-foreground">
              {inc.title}
            </h1>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex shrink-0 flex-nowrap items-center gap-2">
              <SeverityPill severity={inc.severity} />
              <LabelPill label={inc.label} />
              <StatusPill status={inc.status} />
            </span>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 tabular-nums">
                <span className="text-xl font-semibold text-foreground">{inc.score}</span>
                <span className="text-sm text-muted-foreground"> / 100</span>
              </span>
              <span className="min-w-0 text-sm text-muted-foreground">{sev.hint}</span>
            </span>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {inc.real_asset_reached ? (
              <Badge variant="tag" tone="bad" className="max-w-full">
                <Coins aria-hidden />
                <span className="truncate">
                  Real asset reached{assets.length ? `: ${assets.join(", ")}` : ""}
                </span>
              </Badge>
            ) : null}
            {inc.honeytoken_used ? (
              <Badge variant="tag" tone="bad" className="max-w-full" title={token || undefined}>
                <KeyRound aria-hidden />
                <span className="truncate">
                  Honeytoken used
                  {token ? (
                    <span className="font-mono" translate="no">
                      : {token}
                    </span>
                  ) : null}
                </span>
              </Badge>
            ) : null}
            {!inc.real_asset_reached && !inc.honeytoken_used ? (
              <Badge variant="tag" tone="ok">
                <ShieldCheck aria-hidden /> Contained to decoys, no real asset touched
              </Badge>
            ) : null}
          </div>

          <dl className="m-0 flex min-w-0 flex-wrap gap-x-8 gap-y-3 border-t border-border pt-3">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Source</dt>
              <dd className="m-0">
                <HashChip hash={inc.src_ip} label="" n={40} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">First seen</dt>
              <dd className="m-0 font-mono text-sm text-foreground tabular-nums">
                {clock(inc.first_event_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last seen</dt>
              <dd className="m-0 text-sm text-foreground tabular-nums">
                <span className="font-mono">{clock(inc.last_event_at)}</span>{" "}
                <span className="text-muted-foreground">
                  (<RelativeTime iso={inc.last_event_at} />)
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Dwell</dt>
              <dd className="m-0 text-sm text-foreground tabular-nums">
                {duration(inc.first_event_at, inc.last_event_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Events</dt>
              <dd className="m-0 text-sm text-foreground tabular-nums">
                {fmtNum(inc.event_count)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">ATT&amp;CK</dt>
              <dd className="m-0">
                {inc.techniques.length ? (
                  <TechList ids={inc.techniques} max={3} />
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </dd>
            </div>
          </dl>
        </div>
      </Card>

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
            "Status updated and written to the audit log.",
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

      <div className={cn("flex min-w-0 flex-col gap-5", CLEAR_STICKY)}>
        <Summary
          inc={inc}
          narrating={narrating}
          onNarrate={async () => {
            setNarrating(true);
            try {
              await api.narrateIncident(inc.id);
              toast(
                "AI summary queued",
                "success",
                "The incident page updates when narration finishes.",
              );
              setTimeout(reload, 2500);
            } catch (e) {
              toast("Couldn't generate the AI summary", "error", e.message);
            } finally {
              setNarrating(false);
            }
          }}
        />

        <Card title="Kill chain" sub={`${reached} of 6 stages reached`}>
          <KillChain stages={inc.stages} severity={inc.severity} />
        </Card>

        <section id="detail-tabs" aria-label="Incident evidence">
          <Card flush>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "timeline", label: TAB_LABEL.timeline, count: events.length },
                { value: "ledger", label: TAB_LABEL.ledger, count: inc.detections.length },
                { value: "iocs", label: TAB_LABEL.iocs },
              ]}
            >
              {tab === "timeline" ? (
                <>
                  <p className="m-0 px-5 pt-3 pb-2 text-xs text-muted-foreground">
                    Oldest first, local time. A coloured edge marks the event that raised the
                    severity.
                  </p>
                  <Timeline events={events} triggerMap={triggerMap} />
                </>
              ) : tab === "ledger" ? (
                <Ledger inc={inc} events={events} />
              ) : (
                <Evidence inc={inc} attacker={attacker} events={events} />
              )}
            </Tabs>
          </Card>
        </section>

        <AuditTrail rows={audit} number={inc.number} incidentId={inc.id} />
      </div>

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
            toast("Couldn't unblock", "error", e.message);
          }
        }}
      />
    </div>
  );
}

export default function IncidentDetailPage() {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <IncidentDetail />
    </Suspense>
  );
}
