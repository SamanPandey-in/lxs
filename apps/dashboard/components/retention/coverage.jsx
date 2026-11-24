"use client";
import { ArrowRight, CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card, CommandCopy, ErrorState, Skeleton } from "@/components/ui";
import { useAsync } from "@/lib/hooks";
import { retentionApi, topRecommendations } from "@/lib/retention";
import { cn } from "@/lib/utils";

/**
 * Coverage (roadmap §3.2): a 0–100 score from fixed, explainable checks. Severity colours are
 * never used here: a low score is a to-do list, not an incident.
 */

/** Score and a plain meter. `aria-valuetext` says the number out loud. */
export function CoverageMeter({ score, max = 100, className }) {
  const pct = Math.max(0, Math.min(100, Math.round((score / (max || 100)) * 100)));
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "text-xl font-semibold tracking-tight tabular-nums",
            score ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {score}
        </span>
        <span className="text-sm text-muted-foreground tabular-nums">/ {max}</span>
      </div>
      <div
        role="meter"
        aria-label="Coverage score"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={score}
        aria-valuetext={`${score} of ${max}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** How to fix one recommendation: a config line, a command and/or a settings link. */
export function FixHint({ fix }) {
  if (!fix) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="m-0 text-sm text-pretty text-muted-foreground">{fix.text}</p>
      {fix.snippet ? <CommandCopy cmd={fix.snippet} label="Copy line" /> : null}
      {fix.cli ? <CommandCopy cmd={fix.cli} /> : null}
      {fix.href ? (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          render={<Link href={fix.href} prefetch={false} />}
          nativeButton={false}
        >
          Open settings <ArrowRight aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

export function Recommendation({ rec, detailed = false }) {
  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-t border-border px-5 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0 text-sm font-medium text-foreground">{rec.title}</span>
        <Badge variant="tag" tone="neutral" className="shrink-0 tabular-nums">
          +{rec.points} points
        </Badge>
      </div>
      {detailed ? <p className="m-0 text-sm text-pretty text-muted-foreground">{rec.why}</p> : null}
      <FixHint fix={rec.fix} />
    </li>
  );
}

/** Overview card: score, the top three recommendations, a link to every check. */
export function CoverageCard() {
  const { data, error, loading, reload } = useAsync(() => retentionApi.coverage(), []);
  const top = topRecommendations(data, 3);
  return (
    <Card
      title="Coverage"
      sub="What LXS can see and stop on this project"
      right={
        <Button
          variant="ghost"
          size="sm"
          render={<Link href="/coverage-score" prefetch={false} />}
          nativeButton={false}
        >
          All checks <ArrowRight aria-hidden />
        </Button>
      }
      flush
    >
      {loading && !data ? (
        <div className="flex flex-col gap-3 px-5 pb-5">
          <Skeleton h={40} />
          <Skeleton h={56} />
        </div>
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} what="the coverage score" />
      ) : (
        <>
          <CoverageMeter score={data.score} max={data.max} className="px-5 pb-4" />
          {top.length ? (
            <ul className="m-0 list-none p-0" aria-label="Top recommendations">
              {top.map((r) => (
                <Recommendation key={r.id} rec={r} />
              ))}
            </ul>
          ) : (
            <p className="m-0 flex items-center gap-2 border-t border-border px-5 py-3 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-ok" aria-hidden /> Every check passes.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** Full breakdown: every check with what we saw, then every recommendation with why. */
export function CoverageReport({ data, onReviewAllowlist, reviewing }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card title="Score">
        <CoverageMeter score={data.score} max={data.max} />
        <p className="m-0 mt-3 max-w-[70ch] text-sm text-pretty text-muted-foreground">
          Each check is pass or fail and worth fixed points; the score is the sum of the checks that
          pass. Nothing is weighted by traffic, so the same setup always gets the same score.
        </p>
      </Card>

      <Card
        title="Checks"
        sub={`${data.checks.filter((c) => c.passed).length} of ${data.checks.length} pass`}
        flush
      >
        <ul className="m-0 list-none p-0">
          {data.checks.map((c) => (
            <li
              key={c.id}
              className="flex min-w-0 items-start gap-3 border-t border-border px-5 py-3"
            >
              {c.passed ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {c.label}
                  <span className="sr-only">{c.passed ? " (passes)" : " (fails)"}</span>
                </span>
                <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {c.detail}
                </span>
              </div>
              <span
                className={cn(
                  "shrink-0 text-sm tabular-nums",
                  c.earned ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {c.earned} / {c.points}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Recommendations"
        sub={data.recommendations.length ? "Biggest gain first" : null}
        right={
          onReviewAllowlist && data.recommendations.some((r) => r.id === "allowlist_reviewed") ? (
            <Button variant="outline" size="sm" onClick={onReviewAllowlist} loading={reviewing}>
              <ShieldCheck aria-hidden /> Mark allowlist reviewed
            </Button>
          ) : null
        }
        flush
      >
        {data.recommendations.length ? (
          <ul className="m-0 list-none p-0">
            {data.recommendations.map((r) => (
              <Recommendation key={r.id} rec={r} detailed />
            ))}
          </ul>
        ) : (
          <p className="m-0 flex items-center gap-2 border-t border-border px-5 py-3 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-ok" aria-hidden /> Nothing to do. Every check
            passes.
          </p>
        )}
      </Card>
    </div>
  );
}
