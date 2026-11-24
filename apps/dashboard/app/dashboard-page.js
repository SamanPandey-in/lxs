"use client";
import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Play,
  Radar,
  Radio,
  ShieldBan,
  Siren,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { KillMini } from "@/components/killchain";
import {
  Button,
  Card,
  ErrorState,
  LabelPill,
  PageHeader,
  SeverityPill,
  Skeleton,
  StatTile,
  StatusDot,
} from "@/components/ui";
import { BlockModal, describeEvent, EventDot, RelativeTime } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useNow } from "@/lib/hooks";
import { STAGE_LABEL, STAGES } from "@/lib/labels";
import { sortBySeverity, storeActions, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { clock, cn, fmtNum, relative, stamp } from "@/lib/utils";

/**
 * The overview answers one question: is anything happening that needs me right now?
 *
 * Template A (agents/ui/layout.md): header with a one-line status sentence, a KPI row,
 * one priority block, then a two-column context area. Global severity counts live in the
 * topbar only (G3), so this page never repeats them.
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
  const sensorGroups = groupSensors(st.decoys);
  const decoysOnline = st.decoys.filter((d) => d.status === "online").length;
  // Hourly series for the KPI sparklines. Re-bucketed when events arrive or the hour turns.
  const hourKey = Math.floor(now / HOUR);
  const trends = useMemo(
    () => kpiTrends(st.events, ov?.series_24h, (hourKey + 1) * HOUR),
    [st.events, ov?.series_24h, hourKey],
  );

  const replay = async () => {
    try {
      await api.replay(PROJECT, { scenario: "ps-use-case" });
      toast("Simulation started", "success", "Replaying the SSH to payments scenario.");
    } catch (e) {
      toast("Couldn't start the simulation", "error", e.message);
    }
  };

  // Never loaded: zero counts here would read as an all-clear nobody has checked.
  if (!st.loaded && st.error)
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader title="Overview" purpose="Platform status is unknown." />
        <ErrorState error={st.error} onRetry={storeActions.refresh} what="platform status" />
      </div>
    );

  const noise = ov?.noise_suppressed_24h ?? 0;
  const status = !st.bootstrapped
    ? "Checking decoys and incidents…"
    : `${
        urgent.length
          ? `${fmtNum(urgent.length)} targeted ${urgent.length === 1 ? "incident needs" : "incidents need"} review.`
          : "No targeted activity open."
      } ${fmtNum(noise)} noise ${noise === 1 ? "event" : "events"} suppressed today, nobody paged.`;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Overview"
        purpose={status}
        actions={
          <>
            <Button variant="outline" onClick={replay}>
              <Play aria-hidden /> Run simulation
            </Button>
            <Button
              variant="outline"
              render={<Link href="/incidents" prefetch={false} />}
              nativeButton={false}
            >
              Incident queue <ArrowRight aria-hidden />
            </Button>
          </>
        }
      />

      <section aria-label="Key figures" className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {!st.bootstrapped ? (
          ["a", "b", "c", "d"].map((k) => <Skeleton key={k} h={116} className="rounded-xl" />)
        ) : (
          <>
            <StatTile label="Open incidents" value={fmtNum(open.length)} icon={Siren} />
            <StatTile
              label="Events, 24 h"
              value={fmtNum(ov?.events_24h ?? 0)}
              icon={Activity}
              {...trendProps(trends.events, ov?.events_24h ?? 0, "Events")}
            />
            <StatTile
              label="Sources, 24 h"
              value={fmtNum(ov?.attackers_24h ?? 0)}
              icon={Radar}
              {...trendProps(trends.sources, ov?.attackers_24h ?? 0, "Distinct sources")}
            />
            <StatTile
              label="Decoys online"
              value={`${fmtNum(decoysOnline)} / ${fmtNum(st.decoys.length)}`}
              icon={Radio}
              tone={decoysOnline < st.decoys.length ? "warn" : "ok"}
            />
          </>
        )}
      </section>

      {!st.bootstrapped ? (
        <Skeleton h={208} className="rounded-xl" />
      ) : lead ? (
        <LeadIncident incident={lead} onBlock={() => setBlockFor(lead)} />
      ) : (
        <Card>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
            <div className="min-w-0">
              <h2 className="m-0 text-lg font-semibold text-foreground">
                No targeted activity open
              </h2>
              <p className="mt-1 mb-0 max-w-[65ch] text-sm text-pretty text-muted-foreground">
                Decoys are watching. Anything that touches one appears here within a second.
              </p>
            </div>
          </div>
        </Card>
      )}

      {alsoUrgent.length > 0 && (
        <Card
          title={`${alsoUrgent.length} more ${alsoUrgent.length === 1 ? "needs" : "need"} attention`}
          sub="Targeted or reached something real"
          flush
        >
          <IncidentRows incidents={alsoUrgent} chain />
        </Card>
      )}

      {/* Everything routine stays one row until asked for: bots scanning the internet
          should never cost an analyst a glance. */}
      {routine.length > 0 && (
        <Card
          title="Routine"
          sub={`${fmtNum(routine.length)} ${routine.length === 1 ? "incident" : "incidents"} · ${summarise(routine)} · batch review`}
          right={
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showRoutine}
              aria-controls="routine-incidents"
              onClick={() => setShowRoutine((v) => !v)}
            >
              {showRoutine ? "Hide" : "Show"}
              <ChevronDown
                aria-hidden
                className={cn(
                  "motion-safe:transition-transform motion-safe:duration-200",
                  showRoutine && "rotate-180",
                )}
              />
            </Button>
          }
          flush
        >
          <div id="routine-incidents" hidden={!showRoutine}>
            {showRoutine && <IncidentRows incidents={routine} />}
          </div>
        </Card>
      )}

      {/* Secondary: context, not calls to action. */}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card
          title="Live activity"
          right={
            <Button
              variant="ghost"
              size="sm"
              render={<Link href="/feed" prefetch={false} />}
              nativeButton={false}
            >
              Open feed <ArrowRight aria-hidden />
            </Button>
          }
          flush
        >
          {!st.bootstrapped ? (
            <ListSkeleton />
          ) : st.events.length === 0 ? (
            <p className="m-0 flex items-center gap-2 border-t border-border px-5 py-4 text-sm text-muted-foreground">
              <Radio className="size-4" aria-hidden /> Waiting for decoy traffic…
            </p>
          ) : (
            <ul className="m-0 list-none p-0" aria-live="polite">
              {st.events.slice(0, 8).map((e) => (
                <li
                  key={e.id}
                  className={cn(
                    "flex h-10 min-w-0 items-center gap-3 border-t border-border px-5",
                    now - new Date(e.received_at).getTime() < 4500 &&
                      "bg-primary/5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
                  )}
                >
                  <EventDot e={e} />
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-foreground"
                    title={describeEvent(e)}
                  >
                    {describeEvent(e)}
                  </span>
                  <span
                    className="hidden max-w-32 shrink-0 truncate font-mono text-xs text-muted-foreground sm:inline"
                    translate="no"
                  >
                    {e.src_ip}
                  </span>
                  <time
                    dateTime={e.occurred_at}
                    title={stamp(e.occurred_at)}
                    className="shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums"
                  >
                    {clock(e.occurred_at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Decoy health"
          right={
            <Button
              variant="ghost"
              size="sm"
              render={<Link href="/decoys" prefetch={false} />}
              nativeButton={false}
            >
              All decoys <ArrowRight aria-hidden />
            </Button>
          }
          flush
        >
          {!st.bootstrapped ? (
            <ListSkeleton />
          ) : (
            <ul className="m-0 list-none p-0">
              {sensorGroups.length === 0 ? (
                <li className="border-t border-border px-5 py-4 text-sm text-muted-foreground">
                  No decoys registered yet. Start a sensor to deploy them.
                </li>
              ) : null}
              {sensorGroups.map((group) => (
                <li key={group.key} className="border-t border-border">
                  <details className="group/sensor">
                    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-3 px-5 py-3 hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid [&::-webkit-details-marker]:hidden">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-foreground">
                          {group.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {group.service} · {group.sensors.length}{" "}
                          {group.sensors.length === 1 ? "decoy" : "decoys"} · heartbeat{" "}
                          {relative(group.latestHeartbeat, now)}
                        </span>
                      </span>
                      <StatusDot tone={healthTone(group.status)} pulse={group.status === "online"}>
                        {healthLabel(group.status)}
                      </StatusDot>
                      <ChevronDown
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground group-open/sensor:rotate-180 motion-safe:transition-transform motion-safe:duration-200"
                      />
                    </summary>
                    <ul className="m-0 flex list-none flex-col gap-3 bg-muted/40 px-5 py-3">
                      {group.sensors.map((d) => (
                        <li key={d.id} className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {d.name}
                            </span>
                            <StatusDot tone={healthTone(d.status)} pulse={d.status === "online"}>
                              {healthLabel(d.status)}
                            </StatusDot>
                          </div>
                          <dl className="m-0 mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                            <Fact term="Decoy key">
                              <span className="font-mono" translate="no">
                                {d.key}
                              </span>
                            </Fact>
                            <Fact term="Sensor">
                              <span className="font-mono" translate="no">
                                {d.sensor?.hostname || "—"}
                              </span>
                            </Fact>
                            <Fact term="Last heartbeat" title={stamp(d.last_heartbeat_at)}>
                              <RelativeTime iso={d.last_heartbeat_at} />
                            </Fact>
                            <Fact term="Last event" title={stamp(d.last_event_at)}>
                              <RelativeTime iso={d.last_event_at} />
                            </Fact>
                            <Fact term="Events, 24 h">
                              <span className="tabular-nums">{fmtNum(d.events_24h ?? 0)}</span>
                            </Fact>
                            <Fact term="Type / persona">
                              {d.type || "—"} · {d.persona || "—"}
                            </Fact>
                            <Fact term="Agent / policy">
                              <span className="font-mono">{d.agent_version || "—"}</span> ·{" "}
                              {d.policy_version ?? "—"}
                            </Fact>
                          </dl>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
              <HealthRow
                name="Platform stream"
                meta="GET /v1/stream"
                tone={st.conn === "live" ? "ok" : st.conn === "demo" ? "info" : "warn"}
                label={
                  st.conn === "live" ? "Live" : st.conn === "demo" ? "Simulated" : "Connecting…"
                }
                pulse={st.conn === "live"}
              />
              {/* The narrator only explains; it never scores. Say plainly when no model is
                  configured rather than implying one is running. */}
              <HealthRow
                name="AI narrator"
                meta={ov?.llm?.model || "Not configured · template summaries"}
                tone={ov?.llm?.model ? "ok" : "neutral"}
                label={ov?.llm?.model ? "Ready" : "Template"}
              />
            </ul>
          )}
        </Card>
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

// The lead incident carries its severity on the surface so it is the first thing the eye lands on.
const SEV_EMPHASIS = {
  critical: { card: "border-l-sev-critical bg-sev-critical/[0.04]", icon: "text-sev-critical" },
  high: { card: "border-l-sev-high bg-sev-high/[0.04]", icon: "text-sev-high" },
  medium: { card: "border-l-sev-medium bg-sev-medium/[0.04]", icon: "text-sev-medium" },
  low: { card: "border-l-sev-low", icon: "text-foreground" },
};

/** The one incident that needs action: text ≤ 65ch, actions right under it, kill chain beside. */
function LeadIncident({ incident: i, onBlock }) {
  const reached = new Set(i.stages || []);
  const sev = SEV_EMPHASIS[i.severity] || SEV_EMPHASIS.low;
  return (
    <Card className={cn("border-l-4", sev.card)}>
      <article className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 max-w-[65ch] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityPill severity={i.severity} score={i.score} />
            <LabelPill label={i.label} />
            <span className="text-sm text-muted-foreground">
              {i.severity === "critical" ? "Act now" : "Needs review"}
            </span>
          </div>
          <h2 className="m-0 text-xl font-semibold text-balance text-foreground">{i.title}</h2>
          <p className="m-0 text-base text-pretty text-muted-foreground">{plainWhy(i)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                render={<Link href={`/incidents/${i.id}`} prefetch={false} />}
                nativeButton={false}
              >
                Investigate <ArrowRight aria-hidden />
              </Button>
              <Button variant="outline" onClick={onBlock}>
                <ShieldBan aria-hidden /> Block source…
              </Button>
            </div>
            <span className="text-sm text-muted-foreground tabular-nums">
              <span className="font-mono text-foreground" translate="no">
                {i.src_ip}
              </span>{" "}
              · {fmtNum(i.event_count)} events · <RelativeTime iso={i.last_event_at} />
            </span>
          </div>
        </div>
        <div className="min-w-0 border-t border-border pt-4 lg:min-w-56 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <h3 className="m-0 text-xs font-medium text-muted-foreground">
            Kill chain · {stagesLabel(i.stages)}
          </h3>
          <ol className="m-0 mt-2 grid list-none grid-cols-2 gap-x-4 gap-y-1.5 p-0 lg:grid-cols-1">
            {STAGES.map((s) => {
              const on = reached.has(s);
              const Icon = on ? Check : Circle;
              return (
                <li
                  key={s}
                  className={cn(
                    "flex items-center gap-2 text-sm",
                    on ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn("size-4 shrink-0", on ? sev.icon : "text-muted-foreground")}
                  />
                  {STAGE_LABEL[s]}
                  <span className="sr-only">{on ? "(reached)" : "(not reached)"}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </article>
    </Card>
  );
}

/** Whole-row links: severity · title (medium) over muted meta · kill-chain mini bar · chevron. */
function IncidentRows({ incidents, chain = false }) {
  return (
    <ul className="m-0 list-none p-0">
      {incidents.map((i) => (
        <li key={i.id} className="border-t border-border">
          <Link
            href={`/incidents/${i.id}`}
            prefetch={false}
            className="group/row flex min-h-14 min-w-0 items-center gap-3 px-5 py-2.5 text-inherit no-underline transition-colors duration-150 ease-out hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid"
          >
            <span className="w-24 shrink-0">
              <SeverityPill severity={i.severity} score={i.score} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-foreground" title={i.title}>
                {i.title}
              </span>
              <span className="flex min-w-0 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
                <span className="font-mono" translate="no">
                  {i.src_ip}
                </span>
                <LabelPill label={i.label} />
                <RelativeTime iso={i.last_event_at} />
              </span>
            </span>
            {chain ? (
              <KillMini stages={i.stages} severity={i.severity} className="hidden sm:inline-flex" />
            ) : null}
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-hover/row:text-foreground motion-safe:group-hover/row:translate-x-0.5"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function HealthRow({ name, meta, tone, label, pulse = false }) {
  return (
    <li className="flex min-w-0 items-center gap-3 border-t border-border px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{meta}</span>
      </div>
      <StatusDot tone={tone} pulse={pulse}>
        {label}
      </StatusDot>
    </li>
  );
}

function Fact({ term, title, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="m-0 truncate text-sm text-foreground" title={title}>
        {children}
      </dd>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col">
      {["a", "b", "c", "d"].map((k) => (
        <div key={k} className="flex h-10 items-center gap-3 border-t border-border px-5">
          <Skeleton h={8} w={8} className="rounded-full" />
          <Skeleton h={12} w="60%" />
        </div>
      ))}
    </div>
  );
}

/* ───────── KPI trends ───────── */

const HOUR = 3_600_000;
/** Mirrors MAX_EVENTS in lib/store.js: the store keeps only the newest this-many events. */
const EVENT_BUFFER = 300;
const MIN_TREND_HOURS = 6;

/**
 * 24 hourly buckets ending at `end` (oldest first): events per hour and distinct source IPs
 * per hour. Events per hour prefer the overview's `series_24h` (mock today; the real API does
 * not send it yet) and fall back to the events the store already holds. When the event buffer
 * is full, hours older than the oldest loaded event are unknown (not zero), so they are dropped.
 */
function kpiTrends(events, series24h, end) {
  const start = end - 24 * HOUR;
  const counts = Array(24).fill(0);
  const ips = Array.from({ length: 24 }, () => new Set());
  let oldest = Number.POSITIVE_INFINITY;
  for (const e of events) {
    const t = new Date(e.occurred_at || e.received_at).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < oldest) oldest = t;
    if (t < start || t >= end) continue;
    const h = Math.floor((t - start) / HOUR);
    counts[h] += e.count > 1 ? e.count : 1;
    if (e.src_ip) ips[h].add(e.src_ip);
  }
  const from =
    events.length >= EVENT_BUFFER && oldest > start
      ? Math.min(24, Math.floor((oldest - start) / HOUR) + 1)
      : 0;
  const fromSeries =
    Array.isArray(series24h) && series24h.length === 24
      ? series24h.map((d) => (d.noise || 0) + (d.opportunistic || 0) + (d.targeted || 0))
      : null;
  return {
    events: fromSeries ?? counts.slice(from),
    sources: ips.slice(from).map((set) => set.size),
  };
}

/**
 * StatTile props for an hourly series: sparkline + sr-only summary, and a delta chip comparing
 * the last 12 h with the 12 h before (only with a full 24 h window and a non-zero baseline).
 * Skipped when the series is too short, or empty while the tile's own total says otherwise.
 */
function trendProps(series, total, what) {
  if (!series || series.length < MIN_TREND_HOURS) return {};
  const sum = series.reduce((a, b) => a + b, 0);
  if (sum === 0 && Number(total) > 0) return {};
  const peak = Math.max(...series);
  const out = {
    trend: series,
    trendLabel: `${what} per hour, last ${series.length} h: peak ${fmtNum(peak)}, latest hour ${fmtNum(series[series.length - 1])}.`,
  };
  if (series.length === 24) {
    const prev = series.slice(0, 12).reduce((a, b) => a + b, 0);
    const last = series.slice(12).reduce((a, b) => a + b, 0);
    if (prev > 0) {
      out.delta = ((last - prev) / prev) * 100;
      // More attack traffic is not good news.
      out.deltaGood = "down";
      out.deltaLabel = "vs previous 12 h";
    }
  }
  return out;
}

/** Beyond this many, a secondary list stops being a list and becomes a wall. */
const MAX_SECONDARY = 3;

const SENSOR_STATUS_ORDER = { online: 0, stale: 1, offline: 2 };
const healthLabel = (status) =>
  status === "online" ? "Online" : status === "offline" ? "Offline" : "Stale";
const healthTone = (status) => (status === "online" ? "ok" : status === "offline" ? "bad" : "warn");

function groupSensors(sensors) {
  const groups = new Map();
  for (const sensor of sensors) {
    const service = sensor.service || sensor.name || sensor.type || "Unknown service";
    const key = service.trim().toLowerCase();
    if (!groups.has(key))
      groups.set(key, { key, service, name: sensor.name || service, sensors: [] });
    groups.get(key).sensors.push(sensor);
  }
  return [...groups.values()]
    .map((group) => {
      group.sensors.sort(
        (a, b) => new Date(b.last_heartbeat_at || 0) - new Date(a.last_heartbeat_at || 0),
      );
      const latestHeartbeat =
        group.sensors.find((sensor) => sensor.last_heartbeat_at)?.last_heartbeat_at || null;
      const status = group.sensors.reduce(
        (worst, sensor) =>
          (SENSOR_STATUS_ORDER[sensor.status] ?? 1) > (SENSOR_STATUS_ORDER[worst] ?? 1)
            ? sensor.status
            : worst,
        "online",
      );
      return { ...group, latestHeartbeat, status };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const ALL_STAGES = STAGES.length;
const stagesLabel = (stages = []) =>
  stages.length >= ALL_STAGES ? `all ${ALL_STAGES} reached` : `${stages.length} of ${ALL_STAGES}`;

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
