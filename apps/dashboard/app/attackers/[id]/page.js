"use client";
import { ArrowLeft, Bot, Coins, HelpCircle, Radio, ShieldBan, ShieldCheck, User } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  LabelPill,
  PageLoading,
  StatusDot,
  TechList,
} from "@/components/ui";
import {
  BlockModal,
  describeEvent,
  EventDot,
  IncidentsTable,
  RelativeTime,
  UnblockModal,
} from "@/components/workspace";
import { api, PROJECT } from "@/lib/core";
import { usePolling } from "@/lib/hooks";
import { EVENT_LABEL } from "@/lib/labels";
import { toast } from "@/lib/toast";
import { clock, cn, duration, fmtNum, stamp } from "@/lib/utils";

function BackLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 self-start"
      render={<Link href="/attackers" prefetch={false} />}
      nativeButton={false}
    >
      <ArrowLeft aria-hidden /> Attackers
    </Button>
  );
}

const CADENCE = {
  human: { icon: User, label: "Human cadence" },
  bot: { icon: Bot, label: "Bot cadence" },
};

export default function AttackerPage() {
  const { id } = useParams();
  const [blockOpen, setBlockOpen] = useState(false);
  const [unblockOpen, setUnblockOpen] = useState(false);
  const { data, error, loading, reload } = usePolling(
    async () => {
      const [a, bl] = await Promise.all([api.attacker(id), api.blocklist(PROJECT)]);
      return { a, bl };
    },
    5000,
    [id],
  );

  if (loading && !data)
    return (
      <div className="ds-page gap-6">
        <PageLoading label="Loading attacker…" />
      </div>
    );
  if (error && !data)
    return (
      <div className="ds-page gap-6">
        <BackLink />
        <ErrorState error={error} onRetry={reload} what="this attacker" />
      </div>
    );
  const { a, bl } = data;
  const fp = a.fingerprints || {};
  const blocked =
    bl.find(
      (b) =>
        b.ip === a.ip &&
        b.status !== "expired" &&
        (!b.expires_at || new Date(b.expires_at) > new Date()),
    ) || null;
  const cadence = CADENCE[a.cadence] ?? { icon: HelpCircle, label: "Cadence unknown" };
  const CadenceIcon = cadence.icon;

  return (
    <div className="ds-page gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <BackLink />
        <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <h1
              className="m-0 font-mono text-2xl font-semibold break-all text-foreground"
              translate="no"
            >
              {a.ip}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <LabelPill label={a.label} />
              <Badge variant="tag" tone="neutral">
                <CadenceIcon aria-hidden />
                {cadence.label}
              </Badge>
              {blocked ? <StatusDot tone="ok">Blocked</StatusDot> : null}
            </div>
            <p className="m-0 max-w-[70ch] text-sm text-muted-foreground">
              First seen {stamp(a.first_seen_at)}, last seen {stamp(a.last_seen_at)} (active for{" "}
              {duration(a.first_seen_at, a.last_seen_at)}).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {blocked ? (
              <Button variant="outline" onClick={() => setUnblockOpen(true)}>
                <ShieldCheck aria-hidden /> Unblock source…
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => setBlockOpen(true)}>
                <ShieldBan aria-hidden /> Block source…
              </Button>
            )}
          </div>
        </header>
      </div>

      <Card title="Facts">
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-4">
          <Fact term="Events">
            <span className="tabular-nums">{fmtNum(a.event_count)}</span>
          </Fact>
          <Fact term="Sessions">
            <span className="tabular-nums">{fmtNum(a.session_count)}</span>
          </Fact>
          <Fact term="Origin">{fp.country || "—"}</Fact>
          <Fact term="Network">{fp.asn || "—"}</Fact>
          <Fact term="Client banner" mono>
            {fp.client_banner || "—"}
          </Fact>
          <Fact term="Entity key" mono>
            {a.entity_key || "—"}
          </Fact>
          <Fact term="Decoys touched" wide>
            {a.decoys_touched?.length ? (
              <span className="flex flex-wrap gap-1.5">
                {a.decoys_touched.map((d) => (
                  <Badge key={d} variant="tag" tone="neutral" className="font-mono" translate="no">
                    {d}
                  </Badge>
                ))}
              </span>
            ) : (
              "—"
            )}
          </Fact>
          <Fact term="Real assets touched" wide>
            {a.real_assets_touched?.length ? (
              <span className="flex flex-wrap gap-1.5">
                {a.real_assets_touched.map((d) => (
                  <Badge key={d} variant="tag" tone="bad">
                    <Coins aria-hidden />
                    {d}
                  </Badge>
                ))}
              </span>
            ) : (
              "—"
            )}
          </Fact>
        </dl>
      </Card>

      <Card title="Behaviour" sub="Attacker-supplied text, rendered as data">
        <div className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
          <Section title="ATT&CK techniques">
            {a.techniques?.length ? (
              <TechList ids={a.techniques} max={8} />
            ) : (
              <Empty>None mapped</Empty>
            )}
          </Section>
          <Section title="Credentials tried (masked)">
            {fp.credentials_tried?.length ? (
              <span className="flex flex-wrap gap-1.5">
                {fp.credentials_tried.map((c) => (
                  <Chip key={c}>{c}</Chip>
                ))}
              </span>
            ) : (
              <Empty>None</Empty>
            )}
          </Section>
          <Section title="Files">
            {fp.files?.length ? (
              <span className="flex flex-wrap gap-1.5">
                {fp.files.map((c) => (
                  <Chip key={c}>{c}</Chip>
                ))}
              </span>
            ) : (
              <Empty>None</Empty>
            )}
          </Section>
          <Section title="User agents">
            {fp.user_agents?.length ? (
              <MonoLines lines={fp.user_agents} />
            ) : (
              <Empty>None</Empty>
            )}
          </Section>
          <Section title="Commands" className="md:col-span-2">
            {fp.commands?.length ? (
              <MonoLines lines={fp.commands} prompt="$ " />
            ) : (
              <Empty>No shell commands</Empty>
            )}
          </Section>
        </div>
      </Card>

      <Card title="Linked incidents" flush>
        {a.incidents?.length ? (
          <IncidentsTable incidents={a.incidents} />
        ) : (
          <EmptyState title="No incidents">
            This source hasn't crossed the incident threshold yet.
          </EmptyState>
        )}
      </Card>

      <Card title="Recent events" flush>
        {a.recent_events?.length ? (
          <ul className="m-0 list-none p-0">
            {a.recent_events.slice(0, 12).map((e) => {
              const detail = describeEvent(e);
              return (
                <li
                  key={e.id}
                  className="flex min-w-0 items-start gap-3 border-t border-border px-5 py-3"
                >
                  <EventDot e={e} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {EVENT_LABEL[e.event_type] || e.event_type}
                    </div>
                    <div
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={detail}
                      translate="no"
                    >
                      {detail}
                    </div>
                  </div>
                  <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    <span className="font-mono">{clock(e.occurred_at)}</span>
                    <span className="hidden sm:inline">
                      {" "}
                      · <RelativeTime iso={e.occurred_at} />
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={Radio} title="No recent events">
            Events from this source show up here as they arrive.
          </EmptyState>
        )}
      </Card>

      <BlockModal
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        ip={a.ip}
        onDone={() => {
          reload();
          setTimeout(reload, 3000);
        }}
      />
      <UnblockModal
        open={unblockOpen}
        onClose={() => setUnblockOpen(false)}
        ip={a.ip}
        onConfirm={async () => {
          await api.unblock(PROJECT, blocked.id);
          toast(`Unblocked ${a.ip}`);
          reload();
        }}
      />
    </div>
  );
}


function Fact({ term, children, mono, wide }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd
        className={cn(
          "m-0 mt-0.5 text-sm [overflow-wrap:anywhere] text-foreground",
          mono && "font-mono",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function Section({ title, children, className }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h3 className="m-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

/** Multi-line attacker text: one mono line each, scrolls inside its own box. */
function MonoLines({ lines, prompt = "" }) {
  return (
    <ul
      className="m-0 max-h-64 list-none overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-sm text-foreground"
      translate="no"
    >
      {lines.map((l) => (
        <li key={l} className="py-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {prompt}
          {l}
        </li>
      ))}
    </ul>
  );
}
