"use client";
import { CheckCheck, ShieldAlert, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import {
  Chip,
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
  Tabs,
  techTitle,
} from "@/components/ui";
import { IncidentsTable, SectionCard } from "@/components/workspace";
import { api } from "@/lib/core";
import { sortBySeverity, storeActions, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";

/** An incident still needs an analyst. Pure, so it lives outside the component. */
const live = (i) => i.status === "open" || i.status === "acknowledged";

function Queue() {
  const st = useStore();
  const sp = useSearchParams();
  const router = useRouter();
  const technique = sp.get("technique");
  const [tab, setTab] = useState(sp.get("tab") || "targeted");

  const all = [...st.incidents.values()];
  const filtered = technique ? all.filter((i) => i.techniques.includes(technique)) : all;
  const lists = useMemo(
    () => ({
      targeted: filtered.filter((i) => i.label === "targeted" && live(i)).sort(sortBySeverity),
      opportunistic: filtered
        .filter((i) => i.label === "opportunistic" && live(i))
        .sort(sortBySeverity),
      noise: filtered.filter((i) => i.label === "noise" && live(i)).sort(sortBySeverity),
      resolved: filtered
        .filter((i) => !live(i))
        .sort((a, b) => new Date(b.last_event_at) - new Date(a.last_event_at)),
    }),
    [filtered],
  );

  const rows = lists[tab];
  const empties = {
    targeted: [
      "No targeted incidents",
      "Human-paced attackers, cross-sensor chains and anything that reaches a real asset land here.",
    ],
    opportunistic: [
      "Nothing to batch-review",
      "Scripted bots that got in with common credentials show up here for periodic review.",
    ],
    noise: [
      "No noise to clear",
      "Scanners and bots are collapsed into a counter and never notify.",
    ],
    resolved: [
      "Nothing resolved yet",
      "Incidents you resolve or mark as false positive are archived here.",
    ],
  };

  const resolveNoise = async () => {
    const ids = lists.noise.map((i) => i.id);
    try {
      const n = await api.bulkResolveNoise(ids);
      toast(`Resolved ${n} noise incident${n === 1 ? "" : "s"}`, "success");
      storeActions.refresh();
    } catch (e) {
      toast("Could not resolve noise", "error", e.message);
    }
  };

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="MONITOR / TRIAGE"
        title="Incident queue"
        purpose="Label decides the queue, severity decides the order. Targeted is the main queue; opportunistic is batch review; noise is counted, not queued."
      />

      <SectionCard
        flush
        title={
          technique ? (
            <span className="row" style={{ gap: 8 }}>
              Filtered by{" "}
              <Chip op="tech" title={techTitle(technique)}>
                {technique}
              </Chip>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => router.push("/incidents")}
              >
                <X /> Clear
              </button>
            </span>
          ) : undefined
        }
        action={
          tab === "noise" && lists.noise.length ? (
            <button type="button" className="btn btn-sm" onClick={resolveNoise}>
              <CheckCheck /> Resolve all noise
            </button>
          ) : null
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "targeted", label: "Targeted", count: lists.targeted.length },
            { value: "opportunistic", label: "Opportunistic", count: lists.opportunistic.length },
            { value: "noise", label: "Noise", count: lists.noise.length },
            { value: "resolved", label: "Resolved", count: lists.resolved.length },
          ]}
        />
        {!st.bootstrapped ? (
          <TableSkeleton />
        ) : !st.loaded && st.error ? (
          <ErrorState error={st.error} onRetry={storeActions.refresh} what="incidents" />
        ) : rows.length === 0 ? (
          <EmptyState icon={ShieldAlert} title={empties[tab][0]}>
            {empties[tab][1]}
          </EmptyState>
        ) : (
          <IncidentsTable incidents={rows} />
        )}
      </SectionCard>
    </div>
  );
}

export default function IncidentsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <TableSkeleton />
        </div>
      }
    >
      <Queue />
    </Suspense>
  );
}
