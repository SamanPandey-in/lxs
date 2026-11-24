"use client";
import { Check, Crosshair, Loader2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CommandCopy,
  ErrorState,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { api, PROJECT } from "@/lib/core";
import {
  announceSampleChange,
  SAMPLE_CHANGED,
  shouldOfferSample,
  testHitPhase,
  waitForTestIncident,
} from "@/lib/first-run";
import { useAsync, useDemo } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { SampleOffer } from "./sample-offer";
import { TestHitCard } from "./test-hit";

// Per-step command, one-sentence note and the place to go next.
const STEPS = {
  project: {
    code: 'curl -X POST $LXS_URL/v1/projects -d \'{"name":"Acme Shop"}\'',
    note: "Or just use the project that was created at sign-up.",
    action: { href: "/settings", label: "Open settings" },
  },
  key: {
    note: "The key is shown once; `npx lxs init` asks for it. Keys are write-only, so a leak can't read your incidents.",
    action: { href: "/settings", label: "Create a key in settings" },
  },
  sdk: { code: "npm i lxs", note: "Then add the one-line middleware to your app." },
  decoys: {
    code: "npx lxs init\ndocker compose -f lxs/docker-compose.yml up -d",
    note: "init writes decoy.config.ts and builds the compose file. Decoys sit on an isolated network.",
    action: { href: "/decoys", label: "Open decoys" },
  },
  sensor: {
    code: "npx lxs selftest --report",
    note: "Verifies containment and registers the sensor. This step ticks when the first heartbeat lands.",
    action: { href: "/system", label: "Open platform health" },
    waiting: "Waiting for sensor",
  },
  agent: {
    code: "npx lxs init --preset shop\nnpx lxs build\nnpx lxs doctor\ndocker compose -f docker-compose.yml -f lxs.compose.yml up -d",
    note: "init writes decoy.config.ts and .env.lxs (it asks for the key), doctor checks Docker, ports and the key. The agent registers itself on its first heartbeat.",
    action: { href: "/system", label: "Open platform health" },
    waiting: "Waiting for agent",
  },
  selftest: {
    code: "npx lxs selftest --report",
    note: "Verifies containment and posts the report. This step ticks when it passes.",
    waiting: "Waiting for self-test",
  },
  incident: {
    code: "curl -i http://localhost:8081/admin",
    note: "Detections group related events into your first incident.",
    action: { href: "/incidents", label: "Open incident queue" },
  },
  event: {
    code: "curl -i http://localhost:8081/admin",
    note: 'Touch any decoy, or press "Trigger a safe test hit". The event shows on the live feed in under a second.',
    action: { href: "/feed", label: "Open live feed" },
    waiting: "Waiting for first event",
  },
};

function StepMark({ state, n }) {
  if (state === "done")
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
        <Check className="size-3.5" aria-hidden />
      </span>
    );
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
        state === "next" ? "border-primary text-primary" : "border-border text-muted-foreground",
      )}
    >
      {n}
    </span>
  );
}

function ChecklistSkeleton() {
  return (
    <Card>
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        <span className="sr-only">Loading setup progress</span>
        <Skeleton h={20} w="min(280px, 70%)" />
        <Skeleton h={6} />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3 py-1">
            <Skeleton h={24} w={24} className="rounded-full" />
            <Skeleton h={14} w={`${40 + ((i * 13) % 30)}%`} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function OnboardingPage() {
  const demo = useDemo();
  const { data, error, reload } = useAsync(() => api.onboarding(PROJECT), []);
  const [steps, setSteps] = useState(null);
  const sample = useAsync(() => api.sampleStatus(PROJECT), []);
  const [hit, setHit] = useState({ sending: false, result: null, incident: null, elapsedMs: 0 });
  const [hitEnd, setHitEnd] = useState(null); // null | "timeout" | error message
  const [loadingSample, setLoadingSample] = useState(false);
  const watch = useRef(null);

  useEffect(() => {
    if (data) setSteps(data.steps || []);
  }, [data]);
  useEffect(() => () => watch.current?.abort(), []);
  // The shell banner can clear sample data; offer it again afterwards.
  const reloadSample = useRef(sample.reload);
  reloadSample.current = sample.reload;
  useEffect(() => {
    const on = () => reloadSample.current();
    window.addEventListener(SAMPLE_CHANGED, on);
    return () => window.removeEventListener(SAMPLE_CHANGED, on);
  }, []);

  const total = steps?.length ?? 0;
  const doneCount = steps ? steps.filter((s) => s.done).length : 0;
  const firstOpen = steps ? steps.findIndex((s) => !s.done) : -1;
  const next = firstOpen >= 0 ? steps[firstOpen] : null;
  const complete = Boolean(steps) && total > 0 && !next;

  const testHit = async () => {
    watch.current?.abort();
    const ctrl = new AbortController();
    watch.current = ctrl;
    setHitEnd(null);
    setHit({ sending: true, result: null, incident: null, elapsedMs: 0 });
    let result;
    try {
      result = await api.testHit(PROJECT);
    } catch (e) {
      setHit({ sending: false, result: null, incident: null, elapsedMs: 0 });
      toast("Could not send the test hit", "error", e.message);
      return;
    }
    setHit({ sending: false, result, incident: null, elapsedMs: 0 });
    reload();
    const incident = await waitForTestIncident({
      srcIp: result.src_ip,
      fetchIncidents: () => api.incidents(PROJECT, "?limit=50"),
      signal: ctrl.signal,
      onTick: ({ elapsedMs }) => {
        if (!ctrl.signal.aborted) setHit((h) => ({ ...h, elapsedMs }));
      },
    });
    if (ctrl.signal.aborted) return;
    if (incident) {
      setHit((h) => ({ ...h, incident }));
      toast(`Incident #${incident.number} opened`, "success", "Your test hit went end to end.");
      reload();
    } else setHitEnd("timeout");
  };

  const loadSample = async () => {
    setLoadingSample(true);
    try {
      await api.loadSample(PROJECT);
      toast(
        "Sample data loading",
        "success",
        'Incidents appear in a few seconds, badged "Sample data".',
      );
      announceSampleChange();
      sample.reload();
      reload();
    } catch (e) {
      toast("Could not load sample data", "error", e.message);
    } finally {
      setLoadingSample(false);
    }
  };

  const hitPhase =
    hitEnd === "timeout"
      ? "timeout"
      : testHitPhase({
          sending: hit.sending,
          sent: Boolean(hit.result),
          incident: hit.incident,
          elapsedMs: hit.elapsedMs,
        });

  const reset = () => {
    setSteps((cur) => cur.map((s, i) => (i >= 4 ? { ...s, done: false } : s)));
    toast('Reset to "waiting for sensor" for the demo', "info");
  };

  const advance = () => {
    // Demo only: tick the next pending step so the wizard can be walked through live.
    setSteps((cur) => {
      const i = cur.findIndex((s) => !s.done);
      return i === -1 ? cur : cur.map((s, k) => (k === i ? { ...s, done: true } : s));
    });
  };

  const header = (
    <PageHeader
      title="Get started"
      purpose="From zero to your first incident in under 10 minutes. Each step ticks itself from real events. No sensor yet? Trigger a safe test hit to see the whole path."
      actions={
        <>
          {demo ? (
            <Button variant="outline" onClick={reset}>
              <RotateCcw aria-hidden /> Reset checklist
            </Button>
          ) : null}
          <Button onClick={testHit} loading={hit.sending}>
            {hit.sending ? null : <Crosshair aria-hidden />} Trigger a safe test hit
          </Button>
        </>
      }
    />
  );

  if (error && !data)
    return (
      <div className="mx-auto flex w-full max-w-[960px] min-w-0 flex-col gap-6">
        {header}
        <Card>
          <ErrorState error={error} onRetry={reload} what="setup progress" />
        </Card>
      </div>
    );

  return (
    <div className="mx-auto flex w-full max-w-[960px] min-w-0 flex-col gap-6">
      {header}

      {hitPhase !== "idle" ? (
        <TestHitCard phase={hitPhase} hit={hit.result} incident={hit.incident} />
      ) : null}

      {!steps ? (
        <ChecklistSkeleton />
      ) : (
        <Card
          title={complete ? `All ${total} steps complete` : `${doneCount} of ${total} complete`}
          sub={complete ? "Events are flowing." : next ? `Next: ${next.label}` : null}
          right={
            complete ? (
              <Button
                variant="outline"
                size="sm"
                render={<Link href="/incidents" />}
                nativeButton={false}
              >
                Open incident queue
              </Button>
            ) : demo ? (
              <Button variant="outline" size="sm" onClick={advance}>
                Simulate: step completes
              </Button>
            ) : null
          }
          flush
        >
          <div className="px-5 pb-4">
            <div
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={doneCount}
              aria-valuetext={`${doneCount} of ${total} steps complete`}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300"
                style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
              />
            </div>
          </div>

          <ol className="m-0 list-none border-t border-border p-0">
            {steps.map((s, i) => {
              const cfg = STEPS[s.key] || {};
              const state = s.done ? "done" : i === firstOpen ? "next" : "todo";
              if (state === "next")
                return (
                  <li
                    key={s.key}
                    aria-current="step"
                    className="flex min-w-0 gap-3 border-b border-border bg-muted/30 px-5 py-4 last:border-b-0"
                  >
                    <StepMark state={state} n={i + 1} />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="m-0 text-base font-medium text-foreground">{s.label}</h3>
                        {cfg.waiting ? (
                          <Badge variant="status" tone="warn">
                            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                            {cfg.waiting}
                          </Badge>
                        ) : null}
                      </div>
                      {cfg.note ? (
                        <p className="m-0 max-w-[70ch] text-sm text-muted-foreground">{cfg.note}</p>
                      ) : null}
                      {cfg.code ? <CommandCopy code={cfg.code} /> : null}
                      {cfg.action ? (
                        <div>
                          <Button
                            variant="outline"
                            size="sm"
                            render={<Link href={cfg.action.href} />}
                            nativeButton={false}
                          >
                            {cfg.action.label}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              return (
                <li
                  key={s.key}
                  className="flex min-h-11 min-w-0 items-center gap-3 border-b border-border px-5 py-2 last:border-b-0"
                >
                  <StepMark state={state} n={i + 1} />
                  <span className="sr-only">{state === "done" ? "Done:" : "To do:"}</span>
                  <span
                    className={cn(
                      "min-w-0 text-base",
                      state === "done" ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {s.label}
                  </span>
                  {state === "done" && s.detail ? (
                    <span className="ml-auto min-w-0 truncate text-sm text-muted-foreground tabular-nums">
                      {s.detail}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </Card>
      )}

      {!demo && shouldOfferSample(sample.data) ? (
        <SampleOffer onLoad={loadSample} busy={loadingSample} />
      ) : null}
    </div>
  );
}
