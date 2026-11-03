"use client";
import { Bot, Coins, User, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  EmptyState,
  ErrorState,
  LabelPill,
  PageHeader,
  Pill,
  Table,
  TableSkeleton,
  THead,
} from "@/components/ui";
import { FilterSelect, RelativeTime, SectionCard, TextFilter } from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { fmtNum } from "@/lib/utils";

export default function AttackersPage() {
  const router = useRouter();
  const { data, error, loading, reload } = usePolling(() => api.attackers(PROJECT), 7000, []);
  const [label, setLabel] = useState("all");
  const [q, setQ] = useState("");
  const rows = useMemo(
    () =>
      (data || [])
        .filter((a) => (label === "all" || a.label === label) && (!q || a.ip.includes(q.trim())))
        .sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at)),
    [data, label, q],
  );

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="MONITOR / ATTACKERS"
        title="Attackers"
        purpose="One profile per source: everything it touched, how it types, and what it tried."
      />
      <SectionCard
        title="Sources seen"
        detail={data ? `${rows.length} of ${data.length}` : undefined}
        flush
      >
        <div className="ds-filter-bar">
          <FilterSelect
            label="Label"
            value={label}
            onChange={setLabel}
            options={[
              { value: "all", label: "All labels" },
              { value: "targeted", label: "Targeted" },
              { value: "opportunistic", label: "Opportunistic" },
              { value: "noise", label: "Noise" },
            ]}
          />
          <TextFilter value={q} onChange={setQ} placeholder="Filter by IP…" label="Source IP" />
        </div>
        {loading && !data ? (
          <TableSkeleton />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title="No attackers match">
            Sources appear here the first time they touch a decoy.
          </EmptyState>
        ) : (
          <Table>
            <THead
              cols={[
                "Source",
                "Label",
                "Cadence",
                { label: "Events", num: true },
                { label: "Sessions", num: true },
                "Decoys touched",
                "Real assets",
                "Last seen",
              ]}
            />
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.id}
                  className="interactive-row"
                  tabIndex={0}
                  onClick={() => router.push(`/attackers/${a.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") router.push(`/attackers/${a.id}`);
                  }}
                >
                  <td>
                    <span className="table-link mono">{a.ip}</span>
                    <span className="table-sub">{a.fingerprints?.country || ""}</span>
                  </td>
                  <td>
                    <LabelPill label={a.label} />
                  </td>
                  <td>
                    <Pill
                      tone={
                        a.cadence === "human" ? "bad" : a.cadence === "bot" ? "drift" : "halted"
                      }
                      icon={a.cadence === "human" ? User : Bot}
                    >
                      {a.cadence}
                    </Pill>
                  </td>
                  <td className="num">{fmtNum(a.event_count)}</td>
                  <td className="num">{a.session_count}</td>
                  <td>
                    <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                      {a.decoys_touched.map((d) => (
                        <span className="chip" key={d}>
                          {d}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {a.real_assets_touched?.length ? (
                      <Pill tone="bad" icon={Coins}>
                        {a.real_assets_touched.join(", ")}
                      </Pill>
                    ) : (
                      <span className="faint">none</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <RelativeTime iso={a.last_seen_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
