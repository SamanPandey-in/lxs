"use client";
import { MailWarning } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { identity, useMe } from "@/lib/identity";

/**
 * Shell banner while the signed-in user's email is unconfirmed. Not dismissable:
 * key creation and invites stay blocked until the link is followed.
 */
export function VerifyEmailBanner() {
  const user = useMe();
  const [state, setState] = useState({ busy: false, note: "", error: false });
  if (!user || user.email_verified !== false) return null;

  const resend = async () => {
    setState({ busy: true, note: "", error: false });
    try {
      const r = await identity.resendVerification();
      setState({
        busy: false,
        error: false,
        note: r?.already_verified
          ? "Your address is already confirmed. Reload the page."
          : `Sent. Check ${user.email} for the link.`,
      });
    } catch (err) {
      setState({ busy: false, error: true, note: err.message });
    }
  };

  return (
    <div
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-foreground md:px-6 dark:bg-warn/15"
    >
      <MailWarning aria-hidden className="size-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <strong className="font-semibold">Confirm your email address.</strong> We sent a link to{" "}
        {user.email}. Until you follow it, you can look around but can't create ingest keys or
        invite people.
        {state.note ? (
          <span className={state.error ? "ml-1 text-destructive" : "ml-1 text-muted-foreground"}>
            {state.note}
          </span>
        ) : null}
      </span>
      <Button variant="outline" size="sm" onClick={resend} loading={state.busy}>
        Resend link
      </Button>
    </div>
  );
}
