"use client";
import { CheckCheck, SearchX, ShieldAlert, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { IncidentQueue } from "@/components/incidents-table";
import {
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  SearchInput,
  Select,
  TableSkeleton,
  Tabs,
  techTitle,
} from "@/components/ui";
import { api } from "@/lib/core";
import { sortBySeverity, storeActions, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";

/** An incident still needs an analyst. Pure, so it lives outside the component. */
const live = (i) => i.status === "open" || i.status === "acknowledged";

const TABS = ["all", "targeted", "opportunistic", "noise", "resolved"];
const SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_OPTIONS = [
  { value: "any", label: "Any severity" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const EMPTY = {
  all: ["Nothing needs review", "Open and acknowledged incidents from every queue land here."],
  targeted: [
    "No targeted incidents",
    "Human-paced attackers, cross-sensor chains and anything that reaches a real asset land here.",
  ],
  opportunistic: [
    "Nothing to batch-review",
    "Scripted bots that got in with common credentials show up here for periodic review.",
  ],
  noise: ["No noise to clear", "Scanners and bots are collapsed into a counter and never notify."],
  resolved: [
    "Nothing resolved yet",
    "Incidents you resolve or mark as false positive are archived here.",
  ],
};

function Queue() {
  const st = useStore();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const technique = sp.get("technique");
  const tab = TABS.includes(sp.get("tab")) ? sp.get("tab") : "all";
  const severity = SEVERITIES.includes(sp.get("severity")) ? sp.get("severity") : "any";
  const urlQ = sp.get("q") || "";
  const [q, setQ] = useState(urlQ);
  const [resolving, setResolving] = useState(false);

  // Write filters to the URL (replace, so Back leaves the page instead of undoing keystrokes).
  const setParams = (patch) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || (k === "tab" && v === "all") || (k === "severity" && v === "any"))
        next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  // Search is local for instant typing and mirrored to ?q= after 200 ms.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the typed value drives the sync
  useEffect(() => {
    if (q === urlQ) return;
    const t = setTimeout(() => setParams({ q: q.trim() || null }), 200);
    return () => clearTimeout(t);
  }, [q]);

  // The store mutates its Map in place, so derive lists on every render (cheap: < 1k rows).
  const all = [...st.incidents.values()];
  const base = all.filter(
    (i) =>
      (!technique || i.techniques.includes(technique)) &&
      (severity === "any" || i.severity === severity),
  );
  const lists = (() => {
    const open = base.filter(live).sort(sortBySeverity);
    return {
      all: open,
      targeted: open.filter((i) => i.label === "targeted"),
      opportunistic: open.filter((i) => i.label === "opportunistic"),
      noise: open.filter((i) => i.label === "noise"),
      resolved: base
        .filter((i) => !live(i))
        .sort((a, b) => new Date(b.last_event_at) - new Date(a.last_event_at)),
    };
  })();
  // Unfiltered size of the current tab, for "3 of 12".
  const tabTotal = all.filter((i) =>
    tab === "resolved" ? !live(i) : live(i) && (tab === "all" || i.label === tab),
  ).length;

  const tq = q.trim().toLowerCase();
  const rows = tq
    ? lists[tab].filter(
        (i) =>
          i.src_ip.includes(tq) ||
          `#${i.number}`.includes(tq) ||
          String(i.number) === tq ||
          i.title.toLowerCase().includes(tq),
      )
    : lists[tab];
  const filtering = Boolean(tq || technique || severity !== "any");

  const clearFilters = () => {
    setQ("");
    setParams({ q: null, technique: null, severity: null });
  };

  const resolveNoise = async () => {
    const ids = lists.noise.map((i) => i.id);
    setResolving(true);
    try {
      const n = await api.bulkResolveNoise(ids);
      toast(`Resolved ${n} noise incident${n === 1 ? "" : "s"}`, "success", "Written to the audit log.");
      storeActions.refresh();
    } catch (e) {
      toast("Couldn't resolve noise", "error", e.message);
    } finally {
      setResolving(false);
    }
  };

  const filterDesc = [
    tq ? `“${q.trim()}”` : null,
    severity !== "any" ? `severity ${severity}` : null,
    technique ? technique : null,
  ]
    .filter(Boolean)
    .join(", ");

  let body;
  if (!st.bootstrapped) body = <TableSkeleton rows={6} cols={6} />;
  else if (!st.loaded && st.error)
    body = (
      <div className="px-5 pt-4 pb-1">
        <PageError error={st.error} onRetry={storeActions.refresh} label="Couldn't load incidents" />
      </div>
    );
  else if (rows.length === 0)
    body = filtering ? (
      <EmptyState
        icon={SearchX}
        title="No incidents match"
        action={
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        }
      >
        Nothing in this tab matches {filterDesc}.
      </EmptyState>
    ) : (
      <EmptyState icon={ShieldAlert} title={EMPTY[tab][0]}>
        {EMPTY[tab][1]}
      </EmptyState>
    );
  else
    body = (
      <>
        {st.error ? (
          <div className="px-5 pt-3">
            <PageError
              error={st.error}
              onRetry={storeActions.refresh}
              label="Showing the last loaded incidents"
            />
          </div>
        ) : null}
        <IncidentQueue incidents={rows} />
      </>
    );

  return (
    <div className="ds-page">
      <PageHeader
        title="Incident queue"
        purpose="Label decides the queue, severity the order. Targeted needs review now, opportunistic is batch review, noise is counted, not queued."
      />

      <Card flush>
        <Tabs
          value={tab}
          onChange={(v) => setParams({ tab: v })}
          tabs={[
            { value: "all", label: "All open", count: lists.all.length },
            { value: "targeted", label: "Targeted", count: lists.targeted.length },
            { value: "opportunistic", label: "Opportunistic", count: lists.opportunistic.length },
            { value: "noise", label: "Noise", count: lists.noise.length },
            { value: "resolved", label: "Resolved", count: lists.resolved.length },
          ]}
          aria-label="Incident queues"
        >
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-3 md:px-5">
          <SearchInput
            value={q}
            onValueChange={setQ}
            placeholder="Filter by IP, #number or title…"
            aria-label="Filter incidents"
            className="min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-auto"
          />
          <Select
            value={severity}
            onValueChange={(v) => setParams({ severity: v })}
            options={SEVERITY_OPTIONS}
            aria-label="Severity"
            className="w-auto min-w-36"
          />
          {technique ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setParams({ technique: null })}
              aria-label={`Remove technique filter ${techTitle(technique).split("\n")[0]}`}
            >
              <span className="font-mono" translate="no">
                {technique}
              </span>
              <X aria-hidden />
            </Button>
          ) : null}
          {filtering && st.bootstrapped ? (
            <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
              {rows.length} of {tabTotal}
            </span>
          ) : null}
          {tab === "noise" && lists.noise.length ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              loading={resolving}
              onClick={resolveNoise}
            >
              <CheckCheck aria-hidden /> Resolve all noise
            </Button>
          ) : null}
        </div>
        {body}
        </Tabs>
      </Card>
    </div>
  );
}

export default function IncidentsPage() {
  return (
    <Suspense fallback={<PageSkeleton label="Loading incidents" />}>
      <Queue />
    </Suspense>
  );
}
