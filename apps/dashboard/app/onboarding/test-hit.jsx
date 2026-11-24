"use client";
import { Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card } from "@/components/ui";
import { cn } from "@/lib/utils";

/*
 * Live progress of the onboarding "safe test hit": sent → detection → incident.
 * The trigger itself is the page's primary action (in the page header); this card only
 * reports what happened and links to the result.
 */

function Row({ state, title, detail, children }) {
  return (
    <li className="flex min-w-0 items-start gap-3 border-b border-border px-5 py-3 last:border-b-0">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
          state === "done" && "bg-ok/15 text-ok",
          state === "active" && "text-primary",
          state === "todo" && "border border-border",
        )}
      >
        {state === "done" ? <Check className="size-3.5" /> : null}
        {state === "active" ? <Loader2 className="size-4 motion-safe:animate-spin" /> : null}
      </span>
      <span className="sr-only">
        {state === "done" ? "Done:" : state === "active" ? "In progress:" : "Waiting:"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={cn(
            "text-base",
            state === "todo" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </span>
        {detail ? <span className="text-sm text-muted-foreground">{detail}</span> : null}
        {children}
      </div>
    </li>
  );
}

/**
 * phase: idle | sending | processing | slow | incident | timeout | error
 * hit: { src_ip, accepted } from POST …/demo/test-hit; incident: the incident it opened.
 */
export function TestHitCard({ phase, hit, incident, error }) {
  const sent = Boolean(hit);
  const sentState = phase === "sending" ? "active" : sent ? "done" : "todo";
  const detectState =
    phase === "incident" ? "done" : phase === "processing" || phase === "slow" ? "active" : "todo";
  const incidentState = phase === "incident" ? "done" : "todo";

  return (
    <Card
      title="Safe test hit"
      sub="A short, labelled brute-force replay against this project. Nothing reaches your servers."
      right={
        <Badge variant="tag" tone="info">
          Test
        </Badge>
      }
      flush
    >
      <ol aria-live="polite" className="m-0 list-none border-t border-border p-0">
        <Row
          state={sentState}
          title="Test events sent"
          detail={
            sent
              ? `${hit.accepted} events from ${hit.src_ip} (a documentation address, never a real source)`
              : phase === "idle"
                ? 'Press "Trigger a safe test hit" to start.'
                : null
          }
        />
        <Row
          state={detectState}
          title="Detection groups them into an incident"
          detail={
            phase === "slow"
              ? "Still working. This usually takes a few seconds; the worker may be busy."
              : phase === "timeout"
                ? "No incident after two minutes. Check that the worker is running on the platform health page."
                : phase === "error"
                  ? error
                  : null
          }
        >
          {phase === "timeout" ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                render={<Link href="/system" />}
                nativeButton={false}
              >
                Open platform health
              </Button>
            </div>
          ) : null}
        </Row>
        <Row
          state={incidentState}
          title={incident ? `Incident #${incident.number} opened` : "First incident opened"}
          detail={incident ? incident.title : null}
        >
          {incident ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                render={<Link href={`/incidents/${incident.id}`} />}
                nativeButton={false}
              >
                Open incident #{incident.number}
              </Button>
            </div>
          ) : null}
        </Row>
      </ol>
    </Card>
  );
}
