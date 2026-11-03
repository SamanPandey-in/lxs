"use client";
import { Check, Loader2, PartyPopper, Play, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CodeBlock, ErrorState, PageHeader, Pill } from "@/components/ui";
import { SectionCard } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { useAsync, useDemo } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import { toast } from "@/lib/toast";

const COMMANDS = {
  project: {
    code: 'curl -X POST $LXS_URL/v1/projects -d \'{"name":"Acme Shop"}\'',
    note: "Or just use the project that was created at sign-up.",
  },
  key: {
    code: "npx lxs keys create --name prod-sensors",
    note: "The key is shown once. Keys are write-only, so a leak cannot read your incidents.",
  },
  sdk: { code: "npm i lxs", note: "Then add the one-line middleware to your app." },
  decoys: {
    code: "npx lxs init\ndocker compose -f lxs/docker-compose.yml up -d",
    note: "init writes decoy.config.ts and builds the compose file. Decoys sit on an isolated network.",
  },
  sensor: {
    code: "npx lxs selftest --report",
    note: "Verifies containment and registers the sensor. This page ticks when the first heartbeat lands.",
  },
  agent: {
    code: "npx lxs init\ndocker compose -f lxs/docker-compose.yml up -d",
    note: "Starts the decoys and the agent. The agent registers itself on its first heartbeat.",
  },
  selftest: {
    code: "npx lxs selftest --report",
    note: "Verifies containment and posts the report. This step ticks when it passes.",
  },
  incident: {
    code: "curl -i http://localhost:8081/admin",
    note: "Detections group related events into your first incident.",
  },
  event: {
    code: 'curl -i http://localhost:8081/admin   # touch a decoy, or press "Run simulation"',
    note: "Any decoy touch counts. You should see it on the live feed in under a second.",
  },
};

export default function OnboardingPage() {
  const demo = useDemo();
  const st = useStore();
  const { data, error, reload } = useAsync(() => api.onboarding(PROJECT), []);
  const [steps, setSteps] = useState(null);
  const [running, setRunning] = useState(false);
  const [sim, setSim] = useState(false);

  useEffect(() => {
    if (data?.steps) setSteps(data.steps);
  }, [data]);

  const doneCount = steps ? steps.filter((s) => s.done).length : 0;
  const firstOpen = steps ? steps.findIndex((s) => !s.done) : -1;
  const complete = steps && firstOpen === -1;

  const simulate = async () => {
    setRunning(true);
    try {
      await api.replay(PROJECT, { scenario: "ps-use-case" });
      toast(
        "Simulation running",
        "success",
        "Replaying SSH decoy → brute force → real Payments API.",
      );
      setSim(true);
      reload();
    } catch (e) {
      toast("Could not start simulation", "error", e.message);
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setSteps((cur) => cur.map((s, i) => (i >= 4 ? { ...s, done: false } : s)));
    setSim(false);
    toast('Reset to "waiting for sensor" for the demo', "info");
  };

  const advance = () => {
    // Demo only: tick the next pending step so the wizard can be walked through live.
    setSteps((cur) => {
      const i = cur.findIndex((s) => !s.done);
      return i === -1 ? cur : cur.map((s, k) => (k === i ? { ...s, done: true } : s));
    });
  };

  if (error && !data)
    return (
      <div className="ds-page">
        <PageHeader eyebrow="SETUP / GET STARTED" title="Setup status unknown" />
        <ErrorState error={error} onRetry={reload} what="setup progress" />
      </div>
    );

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="SETUP / GET STARTED"
        title="From zero to first event in under 10 minutes"
        purpose="Every command is copyable and every step ticks itself from real events. No sensor yet? Run the simulation."
        actions={
          <>
            <button type="button" className="btn btn-primary" onClick={simulate} disabled={running}>
              {running ? <Loader2 className="spin" /> : <Play />} Run simulation
            </button>
            {demo ? (
              <button type="button" className="btn" onClick={reset}>
                <RotateCcw /> Reset checklist
              </button>
            ) : null}
          </>
        }
      />

      <div className="status-banner" data-tone={complete ? "ok" : "drift"}>
        {complete ? <PartyPopper size={16} /> : <Loader2 size={16} className="spin" />}
        <strong>
          {complete
            ? "All set: events are flowing."
            : firstOpen === 4
              ? "Waiting for sensor…"
              : firstOpen === 5
                ? "Waiting for first event…"
                : `Step ${firstOpen + 1} of 6 is next`}
        </strong>
        <span className="dim">
          {doneCount} of {steps?.length || 6} complete · {st.events.length} events seen in this
          session
        </span>
        <span className="spacer" />
        {complete ? (
          <Link className="btn btn-sm btn-primary" href="/incidents">
            Open the incident queue
          </Link>
        ) : demo ? (
          <button type="button" className="btn btn-sm" onClick={advance}>
            Simulate: sensor connects
          </button>
        ) : null}
      </div>

      <SectionCard title="Checklist" detail="Mirrors the architecture diagram steps 0–5" flush>
        <div className="steps">
          {(steps || []).map((s, i) => {
            const active = i === firstOpen;
            const cmd = COMMANDS[s.key];
            return (
              <div
                key={s.key}
                className={`step${s.done ? " is-done" : ""}${active ? " is-active" : ""}`}
              >
                <div className="step-mark">{s.done ? <Check /> : i + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <h3>{s.label}</h3>
                    {s.done ? (
                      <Pill tone="ok">Done</Pill>
                    ) : active ? (
                      <Pill tone="drift" icon={Loader2}>
                        {s.key === "sensor" || s.key === "selftest"
                          ? "Waiting for sensor"
                          : s.key === "event"
                            ? "Waiting for first event"
                            : "Next"}
                      </Pill>
                    ) : (
                      <Pill tone="halted">Pending</Pill>
                    )}
                  </div>
                  <p>{s.done ? s.detail || "Done" : cmd?.note}</p>
                  {(!s.done || active) && cmd ? <CodeBlock>{cmd.code}</CodeBlock> : null}
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      {sim ? (
        <div className="status-banner" data-tone="ok">
          <Check size={15} /> Simulation sent. Open the{" "}
          <Link href="/feed" className="table-link">
            live feed
          </Link>{" "}
          or the{" "}
          <Link href="/incidents" className="table-link">
            incident queue
          </Link>
          .
        </div>
      ) : null}
    </div>
  );
}
