"use client";
import { Pause, Play, Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  EmptyState,
  PageHeader,
  Pill,
  SeverityPill,
  Table,
  TableSkeleton,
  THead,
} from "@/components/ui";
import { describeEvent, FilterSelect, SectionCard, TextFilter } from "@/components/workspace";
import { useNow } from "@/lib/hooks";
import { EVENT_LABEL, eventTone } from "@/lib/labels";
import { storeActions, useStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { clock } from "@/lib/utils";

export default function FeedPage() {
  const st = useStore();
  const router = useRouter();
  const now = useNow(4000);
  const [decoy, setDecoy] = useState("all");
  const [type, setType] = useState("all");
  const [q, setQ] = useState("");
  const [hideSim, setHideSim] = useState(false);

  const decoyOpts = [
    { value: "all", label: "All decoys" },
    ...st.decoys.map((d) => ({ value: d.id, label: d.name })),
    { value: "app", label: "Real app (SDK)" },
  ];
  const typeOpts = [
    { value: "all", label: "All event types" },
    ...Object.entries(EVENT_LABEL).map(([k, v]) => ({ value: k, label: v })),
  ];

  const rows = useMemo(
    () =>
      st.events.filter((e) => {
        if (decoy !== "all" && (decoy === "app" ? e.decoy_id : e.decoy_id !== decoy)) return false;
        if (type !== "all" && e.event_type !== type) return false;
        if (hideSim && e.simulated) return false;
        if (q && !e.src_ip.includes(q.trim())) return false;
        return true;
      }),
    [st.events, decoy, type, q, hideSim],
  );

  const open = (e) => {
    if (e.incident_id) router.push(`/incidents/${e.incident_id}`);
    else
      toast(
        "No incident for this event",
        "info",
        "A single decoy touch stays below the incident threshold.",
      );
  };

  const tone = st.conn === "live" ? "ok" : st.conn === "demo" ? undefined : "drift";

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="MONITOR / LIVE FEED"
        title="Live feed"
        purpose="Every decoy touch as it happens. Click a row to jump to the incident it belongs to."
      />

      <div className="status-banner" data-tone={tone}>
        <Radio size={15} aria-hidden />
        <span>
          {st.conn === "live"
            ? "Streaming from the platform."
            : st.conn === "demo"
              ? "Simulated stream: a new decoy event arrives every few seconds."
              : "Reconnecting to the stream…"}
        </span>
        <span className="spacer" />
        <span className="dim num">
          {st.events.length} events loaded
          {st.liveCount ? ` · ${st.liveCount} since you opened this tab` : ""}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => storeActions.setPaused(!st.paused)}
        >
          {st.paused ? (
            <>
              <Play /> Resume
            </>
          ) : (
            <>
              <Pause /> Pause
            </>
          )}
        </button>
      </div>

      <SectionCard title="Decoy events" detail={`${rows.length} shown`} flush>
        <div className="ds-filter-bar">
          <FilterSelect label="Decoy" value={decoy} onChange={setDecoy} options={decoyOpts} />
          <FilterSelect label="Event type" value={type} onChange={setType} options={typeOpts} />
          <TextFilter
            value={q}
            onChange={setQ}
            placeholder="Filter by source IP…"
            label="Source IP"
          />
          <label className="row" style={{ gap: 6, height: 30, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={hideSim}
              onChange={(e) => setHideSim(e.target.checked)}
            />{" "}
            Hide simulated
          </label>
        </div>
        {!st.bootstrapped ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={Radio} title="No events match">
            Loosen the filters, or wait for the next decoy touch.
          </EmptyState>
        ) : (
          <Table>
            <THead cols={["Time", "Source", "Decoy", "Event", "Detail", "Incident"]} />
            <tbody>
              {rows.slice(0, 120).map((e) => {
                const inc = e.incident_id ? st.incidents.get(e.incident_id) : null;
                return (
                  <tr
                    key={e.id}
                    className={`interactive-row${now - new Date(e.received_at).getTime() < 4500 ? " is-new" : ""}`}
                    tabIndex={0}
                    onClick={() => open(e)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") open(e);
                    }}
                  >
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {clock(e.occurred_at)}
                    </td>
                    <td className="mono">{e.src_ip}</td>
                    <td>{e.decoy_id || <Pill tone="bad">real app</Pill>}</td>
                    <td>
                      <span className="row" style={{ gap: 7 }}>
                        <span
                          className="ds-dot"
                          style={{ marginTop: 0 }}
                          data-tone={eventTone(e)}
                        />
                        {EVENT_LABEL[e.event_type] || e.event_type}
                      </span>
                    </td>
                    <td>
                      <div className="cell-clip mono" style={{ maxWidth: 360 }}>
                        {describeEvent(e)}
                      </div>
                    </td>
                    <td>
                      {inc ? (
                        <span className="row" style={{ gap: 6 }}>
                          <SeverityPill severity={inc.severity} />
                          <span className="dim">#{inc.number}</span>
                        </span>
                      ) : (
                        <span className="faint">below threshold</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
