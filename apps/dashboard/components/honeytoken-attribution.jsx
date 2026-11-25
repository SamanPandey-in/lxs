"use client";
import { KeyRound } from "lucide-react";
import { useMemo } from "react";
import { Badge, Card } from "@/components/ui";
import { leakSentence, tokenLeaks } from "@/lib/honeytoken-attribution";
import { stamp } from "@/lib/utils";

/**
 * "Which token leaked where": for every honeytoken used in this incident, who the token was minted
 * for (source, time, bait path) and where it came back from. Renders nothing without a token use.
 */
export function HoneytokenAttribution({ events }) {
  const rows = useMemo(() => tokenLeaks(events), [events]);
  if (rows.length === 0) return null;
  return (
    <Card
      title="Which token leaked where"
      sub="Each visitor gets its own honeytoken, so a used token points back at the visit that took it."
    >
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.tokenId} className="flex items-start gap-3 text-sm">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{leakSentence(r, stamp)}</p>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <code className="font-mono">{r.tokenId}</code>
                {r.attributed ? (
                  <Badge>{r.handedOff ? "Different source than the visit" : "Same source"}</Badge>
                ) : null}
                {r.sessionId ? <span>session {r.sessionId.slice(0, 8)}…</span> : null}
                {r.decoyId ? <span>decoy {r.decoyId}</span> : null}
                {r.usedOn ? <span>used on {r.usedOn}</span> : null}
                {r.uses > 1 ? <span>{r.uses} uses</span> : null}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
