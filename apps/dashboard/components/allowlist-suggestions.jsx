"use client";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge, Button, EmptyState, ErrorState, TableSkeleton } from "@/components/ui";
import { RelativeTime, SectionCard } from "@/components/workspace";
import { useAsync } from "@/lib/hooks";
import { responseApi, SUGGESTION_KIND } from "@/lib/response";
import { toast } from "@/lib/toast";
import { fmtNum } from "@/lib/utils";

/** Blocklist page: sources on real routes that look like your own infrastructure. */
export default function AllowlistSuggestions() {
  const { data, error, loading, reload } = useAsync(() => responseApi.suggestions(), []);
  const [busy, setBusy] = useState(null);
  const [added, setAdded] = useState([]);

  const add = async (s) => {
    setBusy(s.cidr);
    try {
      await responseApi.addToAllowlist(s.cidr);
      setAdded((a) => [...a, s.cidr]);
      toast(
        `Added ${s.cidr} to the allowlist`,
        "success",
        "It will never be scored or blocked. Logged to audit.",
      );
    } catch (e) {
      toast(`Couldn't add ${s.cidr}`, "error", e.message);
    } finally {
      setBusy(null);
    }
  };

  const items = (data?.items || []).filter((s) => !added.includes(s.cidr));
  return (
    <SectionCard
      title="Allowlist suggestions"
      detail={
        data
          ? `${fmtNum(items.length)} from the last ${data.window_days} days of real-route traffic`
          : undefined
      }
      flush
    >
      {loading && !data ? (
        <TableSkeleton cols={4} rows={2} />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} what="allowlist suggestions" />
      ) : items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No suggestions">
          Health checks, uptime monitors, CI runners and steady benign traffic hitting your real
          routes show up here, so you can allowlist them before they are ever blocked.
        </EmptyState>
      ) : (
        <ul className="m-0 list-none p-0">
          {items.map((s) => (
            <li
              key={s.cidr}
              className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium text-foreground" translate="no">
                    {s.cidr}
                  </span>
                  <Badge variant="tag" tone="info">
                    {SUGGESTION_KIND[s.kind] || s.kind}
                  </Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtNum(s.events)} requests · {s.days} days
                    {s.last_seen ? (
                      <>
                        {" "}
                        · last <RelativeTime iso={s.last_seen} />
                      </>
                    ) : null}
                  </span>
                </span>
                <ul className="m-0 list-disc pl-5 text-sm text-muted-foreground">
                  {s.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
              <Button variant="outline" size="sm" loading={busy === s.cidr} onClick={() => add(s)}>
                Add to allowlist
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
