"use client";
import { CheckCircle2, Circle, Flag, VolumeX, X } from "lucide-react";
import { useEffect, useState } from "react";
import { CoverageCard } from "@/components/retention/coverage";
import { Button, Card, ErrorState, Skeleton, StatTile } from "@/components/ui";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { resolveProject } from "@/lib/core";
import { useAsync } from "@/lib/hooks";
import {
  milestoneStrip,
  milestoneToAnnounce,
  noiseShare,
  pctChange,
  readDismissed,
  retentionApi,
  writeDismissed,
} from "@/lib/retention";
import { cn, fmtNum, stamp } from "@/lib/utils";

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const shortDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : "—");

/** "Noise you did not have to read": the weekly digest's noise number, last 7 days. */
export function NoiseTile() {
  const { data, error, loading } = useAsync(() => retentionApi.noise(), []);
  if (loading && !data) return <Skeleton h={116} className="rounded-xl" />;
  if (error && !data)
    return (
      <StatTile
        label="Noise you did not have to read, 7 d"
        value="—"
        icon={VolumeX}
        hint="Couldn't load this number."
      />
    );
  const share = noiseShare(data);
  return (
    <StatTile
      label="Noise you did not have to read, 7 d"
      value={fmtNum(data.events)}
      icon={VolumeX}
      delta={pctChange(data.events, data.previous?.events)}
      deltaGood="none"
      deltaLabel="vs the 7 days before"
      hint={
        data.events
          ? `${fmtNum(data.incidents)} ${data.incidents === 1 ? "incident" : "incidents"} labelled noise or auto-closed · ${share} % of all events`
          : "Nothing was filtered out this week."
      }
    />
  );
}

/** Every milestone, reached ones with their date. Not-yet ones stay muted, never alarming. */
export function MilestonesStrip({ items }) {
  const strip = milestoneStrip(items);
  const reached = strip.filter((m) => m.reached).length;
  return (
    <Card title="Milestones" sub={`${reached} of ${strip.length} reached`} flush>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-4 p-0 sm:grid-cols-2">
        {strip.map((m) => (
          <li
            key={m.key}
            className="flex min-w-0 items-start gap-2.5 border-t border-border px-5 py-2.5"
          >
            {m.reached ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="flex min-w-0 flex-col">
              <span
                className={cn(
                  "truncate text-sm",
                  m.reached ? "font-medium text-foreground" : "text-muted-foreground",
                )}
                title={m.description || m.title}
              >
                {m.title}
              </span>
              <span className="text-xs text-muted-foreground">
                {m.reached ? (
                  <time dateTime={m.reached_at} title={stamp(m.reached_at)}>
                    {shortDate(m.reached_at)}
                  </time>
                ) : (
                  "Not yet"
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * One quiet banner when a milestone was newly reached. Dismissal is remembered per browser;
 * only the newest qualifying milestone is ever shown.
 */
export function MilestoneBanner({ items }) {
  const [pid, setPid] = useState(null);
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => {
    let live = true;
    resolveProject()
      .then((id) => {
        if (!live) return;
        setPid(id);
        setDismissed(readDismissed(id));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!pid || !dismissed || !items) return null;
  const m = milestoneToAnnounce(items, dismissed);
  if (!m) return null;
  const close = () => {
    writeDismissed(pid, m.key);
    setDismissed((d) => [...(d || []), m.key]);
  };
  return (
    <Alert role="status">
      <Flag aria-hidden />
      <AlertTitle>Milestone: {m.title}</AlertTitle>
      <AlertDescription>
        {m.description ? `${m.description} ` : ""}Reached{" "}
        <time dateTime={m.reached_at} title={stamp(m.reached_at)}>
          {shortDate(m.reached_at)}
        </time>
        .
      </AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss milestone" onClick={close}>
          <X aria-hidden />
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** The overview's retention block: coverage, the noise counter and milestones. */
export function RetentionOverview() {
  const ms = useAsync(() => retentionApi.milestones(), []);
  return (
    <section aria-label="Coverage and milestones" className="flex min-w-0 flex-col gap-4">
      <MilestoneBanner items={ms.data} />
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <CoverageCard />
        <div className="flex min-w-0 flex-col gap-4">
          <NoiseTile />
          {ms.loading && !ms.data ? (
            <Skeleton h={160} className="rounded-xl" />
          ) : ms.error && !ms.data ? (
            <Card title="Milestones" flush>
              <ErrorState error={ms.error} onRetry={ms.reload} what="milestones" />
            </Card>
          ) : (
            <MilestonesStrip items={ms.data} />
          )}
        </div>
      </div>
    </section>
  );
}
