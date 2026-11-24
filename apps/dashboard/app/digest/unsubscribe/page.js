"use client";
import { CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PublicShell } from "@/components/AuthForm";
import { Button } from "@/components/ui/button";
import { retentionApi } from "@/lib/retention";

const FOOTER = "You can turn the digest back on in Settings at any time.";

/**
 * Public: the link in every digest email. A click, not an automatic request, so a mail
 * scanner that prefetches the link does not unsubscribe anyone.
 */
function Unsubscribe() {
  const token = useSearchParams().get("token") || "";
  const [state, setState] = useState({ status: "idle", error: "" });

  const confirm = async () => {
    setState({ status: "busy", error: "" });
    try {
      await retentionApi.unsubscribe(token);
      setState({ status: "done", error: "" });
    } catch (err) {
      setState({ status: "error", error: err.message });
    }
  };

  return (
    <PublicShell footer={FOOTER}>
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-4 py-10 sm:my-auto">
        <section
          aria-labelledby="unsub-title"
          className="flex flex-col gap-6 rounded-lg border border-border bg-card p-6"
        >
          <div className="flex flex-col gap-1">
            <h1 id="unsub-title" className="m-0 text-2xl font-semibold tracking-[-0.01em]">
              {state.status === "done" ? "You're unsubscribed" : "Stop the weekly digest"}
            </h1>
            <p className="m-0 text-sm text-muted-foreground">
              {state.status === "done"
                ? "No more weekly digest emails. Incident alerts are not affected."
                : "You'll stop getting the weekly digest email for every project. Incident alerts are not affected."}
            </p>
          </div>
          {!token ? (
            <p role="alert" className="m-0 flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                The link has no token. Open it again from the email, or turn the digest off in
                Settings.
              </span>
            </p>
          ) : state.status === "done" ? (
            <p role="status" className="m-0 flex items-start gap-2 text-sm text-foreground">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
              <span>Done.</span>
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {state.error ? (
                <p role="alert" className="m-0 flex items-start gap-2 text-sm text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{state.error}</span>
                </p>
              ) : null}
              <Button
                size="lg"
                className="h-10 w-full"
                onClick={confirm}
                loading={state.status === "busy"}
              >
                Unsubscribe
              </Button>
            </div>
          )}
          <Button variant="ghost" render={<Link href="/settings#digest" />} nativeButton={false}>
            Digest settings
          </Button>
        </section>
      </div>
    </PublicShell>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={null}>
      <Unsubscribe />
    </Suspense>
  );
}
