"use client";
import { FlaskConical } from "lucide-react";
import { Button, Card } from "@/components/ui";

/** Shown on a project with no real events yet. Loading is a secondary action; the test hit is primary. */
export function SampleOffer({ onLoad, busy }) {
  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-muted-foreground"
        >
          <FlaskConical className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 text-base font-medium text-foreground">Explore with sample data</h2>
          <p className="m-0 max-w-[70ch] text-sm text-muted-foreground">
            No events yet. Load four labelled sample attacks to see incidents, attackers and the
            ATT&amp;CK view filled in. They carry a "Sample data" badge and clear in one click.
          </p>
        </div>
        <Button variant="outline" onClick={onLoad} loading={busy}>
          Load sample data
        </Button>
      </div>
    </Card>
  );
}
