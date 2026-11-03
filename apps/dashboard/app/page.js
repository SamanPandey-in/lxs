"use client";
import { ArrowRight, CheckCircle2, ChevronDown, Play, Radio, ShieldBan } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { KillMini } from "@/components/killchain";
import { LabelPill, PageHeader, Pill, SeverityPill, Skeleton } from "@/components/ui";
import { BlockModal, describeEvent, RelativeTime, SectionCard } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useNow } from "@/lib/hooks";
import { eventTone } from "@/lib/labels";
import { sortBySeverity, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { clock, fmtNum, relative } from "@/lib/utils";

/**
 * The overview answers one question: is anything happening that needs me right now?
 *
 * It used to answer it badly — four stat tiles, two incident lists, a chart and three
 * right-rail cards, all at the same visual weight, so the one targeted incident that
 * mattered took less space than the block of opportunistic bots underneath it. Now there
 * is a single focal element, everything routine collapses to one line, and activity is
 * clearly secondary.
 */
export default function Overview() {
  const st = useStore();
  const now = useNow(5000);
  const ov = st.overview;
  const [showRoutine, setShowRoutine] = useState(false);
  const [blockFor, setBlockFor] = useState(null);

  const all = [...st.incidents.values()];
  const open = all.filter((i) => i.status === "open" || i.status === "acknowledged");

  // "Needs you" means a human is on the other end, or they got to something real.
  const urgent = open
    .filter((i) => i.label === "targeted" || i.real_asset_reached || i.honeytoken_used)
    .sort(sortBySeverity);
  const lead = urgent[0] ?? null;
  // Cap the secondary list. Five near-identical rows rebuild exactly the wall this
  // redesign exists to remove; the rest roll up with everything else routine.
  const alsoUrgent = urgent.slice(1, 1 + MAX_SECONDARY);
  const overflow = urgent.slice(1 + MAX_SECONDARY);
  const routine = [...open.filter((i) => !urgent.includes(i)), ...overflow].sort(sortBySeverity);

  const crit = open.filter((i) => i.severity === "critical").length;
  const high = open.filter((i) => i.severity === "high").length;

  const replay = async () => {
    try {
      await api.replay(PROJECT, { scenario: "ps-use-case" });
      toast("Simulation started", "success", "Replaying the SSH to payments scenario.");
    } catch (e) {
      toast("Could not start simulation", "error", e.message);
    }
  };

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="SOC OVERVIEW"
        title={lead ? "Something needs you" : "Nothing needs you"}
        actions={
          <>
            <button type="button" className="btn" onClick={replay}>
              <Play /> Run simulation
            </button>
            <Link href="/incidents" className="btn btn-primary">
              Incident queue <ArrowRight />
            </Link>
          </>
        }
      />

      {/* The counts that used to be four stat tiles. One line says the same thing. */}
      <div className="ds-counts" role="group" aria-label="Open incident summary">
        <span>
          <strong className="num">{fmtNum(crit)}</strong> critical
        </span>
        <span className="ds-counts-sep" aria-hidden />
        <span>
          <strong className="num">{fmtNum(high)}</strong> high
        </span>
        <span className="ds-counts-sep" aria-hidden />
        <span className="dim">
          <strong className="num">{fmtNum(ov?.noise_suppressed_24h ?? 0)}</strong> noise suppressed
          today, nobody paged
        </span>
      </div>

      <div className="ds-stack" style={{ marginTop: 26 }}>
        {!st.bootstrapped ? (
          <Skeleton style={{ height: 190, borderRadius: 14 }} />
        ) : lead ? (
          <article className="ds-focus" data-sev={lead.severity}>
            <div className="ds-focus-eyebrow">
              {lead.severity === "critical" ? "Critical — act now" : "Needs review"}
            </div>
            <h2 className="ds-focus-title">{lead.title}</h2>
            <p className="ds-focus-sub">{plainWhy(lead)}</p>

            <div className="ds-focus-chain">
              <KillMini stages={lead.stages} severity={lead.severity} />
              <span className="ds-focus-chain-label">{stagesLabel(lead.stages)}</span>
            </div>

            <div className="ds-focus-foot">
              <Link href={`/incidents/${lead.id}`} className="btn btn-primary" prefetch={false}>
                Investigate <ArrowRight />
              </Link>
              <button type="button" className="btn" onClick={() => setBlockFor(lead)}>
                <ShieldBan /> Block source
              </button>
              <span className="ds-focus-facts">
                <span className="mono">{lead.src_ip}</span> · {lead.event_count} events ·{" "}
                <RelativeTime iso={lead.last_event_at} />
              </span>
            </div>
          </article>
        ) : (
          <div className="ds-allclear">
            <CheckCircle2 size={22} style={{ color: "var(--ok)" }} aria-hidden />
            <div>
              <strong>No targeted activity open.</strong>
              <div className="dim" style={{ marginTop: 2 }}>
                Decoys are watching. Anything that touches one appears here within a second.
              </div>
            </div>
          </div>
        )}

        {alsoUrgent.length > 0 && (
          <SectionCard
            title={`${alsoUrgent.length} more need${alsoUrgent.length === 1 ? "s" : ""} attention`}
            flush
          >
            {alsoUrgent.map((i) => (
              <Link
                key={i.id}
                href={`/incidents/${i.id}`}
                className="ds-res"
                prefetch={false}
                aria-label={i.title}
              >
                <SeverityPill severity={i.severity} score={i.score} />
                <div className="ds-res-main" style={{ minWidth: 0 }}>
                  <div className="truncate">{i.title}</div>
                  <div className="ds-res-meta row" style={{ gap: 8 }}>
                    <span className="mono">{i.src_ip}</span>
                    <LabelPill label={i.label} />
                    <RelativeTime iso={i.last_event_at} />
                  </div>
                </div>
                <KillMini stages={i.stages} severity={i.severity} />
                <ArrowRight size={14} className="faint" />
              </Link>
            ))}
          </SectionCard>
        )}

        {/* Everything routine stays one line until asked for. This is the whole point of
            the product: bots scanning the internet should never cost an analyst a glance. */}
        {routine.length > 0 && (
          <div>
            <button
              type="button"
              className="ds-rollup"
              aria-expanded={showRoutine}
              onClick={() => setShowRoutine((v) => !v)}
            >
              <span className="ds-rollup-count">{routine.length}</span>
              <span>
                routine {routine.length === 1 ? "incident" : "incidents"}
                <span className="ds-rollup-note"> {summarise(routine)} · batch review</span>
              </span>
              <ChevronDown size={16} className="ds-rollup-chev" aria-hidden />
            </button>

            {showRoutine && (
              <SectionCard flush>
                {routine.map((i) => (
                  <Link
                    key={i.id}
                    href={`/incidents/${i.id}`}
                    className="ds-res"
                    prefetch={false}
                    aria-label={i.title}
                  >
                    <SeverityPill severity={i.severity} score={i.score} />
                    <div className="ds-res-main" style={{ minWidth: 0 }}>
                      <div className="truncate">{i.title}</div>
                      <div className="ds-res-meta row" style={{ gap: 8 }}>
                        <span className="mono">{i.src_ip}</span>
                        <LabelPill label={i.label} />
                        <RelativeTime iso={i.last_event_at} />
                      </div>
                    </div>
                    <ArrowRight size={14} className="faint" />
                  </Link>
                ))}
              </SectionCard>
            )}
          </div>
        )}

        {/* ── Secondary: context, not calls to action ──────────────────────────────── */}
        <section className="ds-secondary ds-two-up">
          <SectionCard
            title="Live activity"
            action={
              <Link href="/feed" className="btn btn-sm btn-ghost" prefetch={false}>
                Open feed <ArrowRight />
              </Link>
            }
            flush
          >
            {st.events.length === 0 ? (
              <div className="ds-quiet-empty">
                <Radio size={15} aria-hidden /> Waiting for decoy traffic
              </div>
            ) : (
              st.events.slice(0, 6).map((e) => (
                <div
                  key={e.id}
                  className={`ds-event${now - new Date(e.received_at).getTime() < 4500 ? " is-new" : ""}`}
                >
                  <span className="ds-dot" data-tone={eventTone(e)} />
                  <div className="ds-event-main">
                    <div className="ds-event-title truncate">{describeEvent(e)}</div>
                    <div className="ds-event-meta mono truncate">{e.src_ip}</div>
                  </div>
                  <span className="ds-event-time">{clock(e.occurred_at)}</span>
                </div>
              ))
            )}
          </SectionCard>

          <SectionCard title="Sensors" flush>
            {st.decoys.map((d) => (
              <div className="health-row" key={d.id}>
                <span
                  className={`health-dot ${d.status === "online" ? "is-live" : d.status === "offline" ? "is-offline" : "is-pending"}`}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate">{d.name}</div>
                  <div className="ds-res-meta">
                    {d.service} · {relative(d.last_heartbeat_at, now)}
                  </div>
                </div>
                <Pill tone={d.status === "online" ? "ok" : "drift"}>
                  {d.status === "online" ? "Online" : "Stale"}
                </Pill>
              </div>
            ))}
            <div className="health-row">
              <span
                className={`health-dot ${st.conn === "live" || st.conn === "demo" ? "is-live" : "is-pending"}`}
              />
              <div style={{ flex: 1 }}>
                <div>Platform stream</div>
                <div className="ds-res-meta">GET /v1/stream</div>
              </div>
              <Pill tone={st.conn === "live" ? "live" : st.conn === "demo" ? "cache" : "drift"}>
                {st.conn === "live" ? "Live" : st.conn === "demo" ? "Simulated" : "Connecting"}
              </Pill>
            </div>
            {/* The narrator only explains; it never scores. Say plainly when no model is
                configured rather than implying one is running. */}
            <div className="health-row">
              <span className={`health-dot ${ov?.llm?.model ? "is-live" : "is-pending"}`} />
              <div style={{ flex: 1 }}>
                <div>AI narrator</div>
                <div className="ds-res-meta">
                  {ov?.llm?.model ? ov.llm.model : "Not configured · template summaries"}
                </div>
              </div>
              <Pill tone={ov?.llm?.model ? "ok" : "halted"}>
                {ov?.llm?.model ? "Ready" : "Template"}
              </Pill>
            </div>
          </SectionCard>
        </section>
      </div>

      <BlockModal
        open={!!blockFor}
        onClose={() => setBlockFor(null)}
        ip={blockFor?.src_ip}
        incident={blockFor}
        onDone={() => setBlockFor(null)}
      />
    </div>
  );
}

/** Beyond this many, a secondary list stops being a list and becomes a wall. */
const MAX_SECONDARY = 3;

const ALL_STAGES = 6;
const stagesLabel = (stages = []) =>
  stages.length >= ALL_STAGES
    ? `all ${ALL_STAGES} stages reached`
    : `${stages.length} of ${ALL_STAGES} stages reached`;

/** One sentence an analyst can act on, instead of a row of chips. */
function plainWhy(i) {
  const bits = [];
  if (i.honeytoken_used) bits.push("used a planted honeytoken");
  if (i.real_asset_reached) bits.push("reached a real application asset");
  if (!bits.length && i.stages?.length) bits.push(`got as far as ${stageWord(i.stages)}`);
  const what = bits.length ? bits.join(" and ") : "touched a decoy";
  return `${i.src_ip} ${what}. Nothing legitimate ever touches these decoys, so this is a real signal.`;
}

const STAGE_WORD = {
  recon: "reconnaissance",
  initial_access: "initial access",
  execution: "running commands",
  discovery: "looking around",
  collection: "collecting data",
  exfiltration: "exfiltration",
};
const stageWord = (stages) => STAGE_WORD[stages[stages.length - 1]] ?? "a decoy";

/** "5 opportunistic · 2 noise" */
function summarise(list) {
  const byLabel = list.reduce((acc, i) => {
    acc[i.label] = (acc[i.label] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(byLabel)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");
}
