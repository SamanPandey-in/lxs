"use client";
import { ArrowRight, Mail } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Button, Card, ErrorState, Skeleton, Switch } from "@/components/ui";
import { useAsync } from "@/lib/hooks";
import { retentionApi } from "@/lib/retention";
import { toast } from "@/lib/toast";

/** "Email me the weekly digest" for the signed-in user (all projects). */
export function DigestEmailToggle() {
  const labelId = useId();
  const { data, error, loading, reload } = useAsync(() => retentionApi.digestPrefs(), []);
  const [local, setLocal] = useState(null);
  const [busy, setBusy] = useState(false);
  const optOut = local ?? data?.opt_out ?? false;

  const toggle = async (on) => {
    setBusy(true);
    setLocal(!on);
    try {
      const r = await retentionApi.setDigestOptOut(!on);
      setLocal(r.opt_out);
      toast(on ? "Weekly digest turned on" : "Weekly digest turned off", "success");
    } catch (err) {
      setLocal(null);
      toast("Could not change the digest setting", "error", err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Skeleton h={40} />;
  if (error && !data)
    return <ErrorState error={error} onRetry={reload} what="your digest setting" />;
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={labelId} className="m-0 text-base font-medium text-foreground">
          Email me the weekly digest
        </p>
        <p className="m-0 mt-0.5 max-w-[60ch] text-sm text-muted-foreground">
          Mondays at 09:00 UTC, to owners and analysts. Attackers caught, incidents, blocks, noise
          filtered out and honeytoken uses, compared with the week before.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="w-6 text-sm text-muted-foreground" aria-hidden>
          {optOut ? "Off" : "On"}
        </span>
        <span aria-busy={busy || undefined}>
          <Switch checked={!optOut} onChange={toggle} label="Email me the weekly digest" />
        </span>
      </div>
    </div>
  );
}

/** Settings section: the email toggle and a link to the preview. */
export function DigestSettings() {
  const headingId = useId();
  return (
    <section id="digest" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={headingId} className="m-0 text-lg font-semibold text-foreground">
            Weekly digest
          </h2>
          <p className="m-0 mt-0.5 max-w-[70ch] text-sm text-muted-foreground">
            A short weekly summary by email. Slack and webhook channels can opt in under
            Notifications.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/digest" prefetch={false} />}
          nativeButton={false}
        >
          <Mail aria-hidden /> Preview this week <ArrowRight aria-hidden />
        </Button>
      </div>
      <Card>
        <DigestEmailToggle />
      </Card>
    </section>
  );
}

/** The rendered email, sandboxed (no scripts, no same-origin access). */
export function DigestPreview() {
  const { data, error, loading, reload } = useAsync(() => retentionApi.digestPreview(), []);
  if (loading && !data) return <Skeleton h={480} className="rounded-xl" />;
  if (error && !data)
    return <ErrorState error={error} onRetry={reload} what="the digest preview" />;
  return (
    <Card title={data.subject} sub="The last 7 days, as the email would show it" flush>
      <iframe
        title="Weekly digest preview"
        sandbox=""
        srcDoc={data.html}
        className="block h-[720px] w-full border-0 border-t border-border bg-muted"
      />
    </Card>
  );
}
