"use client";
import { FlaskConical } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/core";
import { announceSampleChange, SAMPLE_CHANGED } from "@/lib/first-run";
import { toast } from "@/lib/toast";

/**
 * Shell banner while the project holds onboarding sample data. Sample incidents also carry a
 * "Sample data" badge in every list; this is the one place to remove them all.
 */
export function SampleDataBanner() {
  const [status, setStatus] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api
      .sampleStatus()
      .then(setStatus)
      .catch(() => setStatus(null)); // a banner never turns an outage into an error
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(SAMPLE_CHANGED, refresh);
    return () => window.removeEventListener(SAMPLE_CHANGED, refresh);
  }, [refresh]);

  if (!status?.loaded) return null;
  const n = status.sample_incidents;

  const clear = async () => {
    setBusy(true);
    try {
      const r = await api.clearSample();
      const d = r?.deleted ?? {};
      toast(
        "Sample data cleared",
        "success",
        `Removed ${d.incidents ?? 0} incidents and ${d.events ?? 0} events. Real data was not touched.`,
      );
      setConfirming(false);
      setStatus(null);
      announceSampleChange();
    } catch (e) {
      toast("Could not clear sample data", "error", e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-link/40 bg-link/10 px-4 py-2 text-sm text-foreground md:px-6 dark:bg-link/15"
    >
      <FlaskConical aria-hidden className="size-4 shrink-0 text-link" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <strong className="font-semibold">You're looking at sample data.</strong>{" "}
        {n > 0
          ? `${n} ${n === 1 ? "incident is" : "incidents are"} labelled "Sample data" and come from documentation addresses (192.0.2.0/24). `
          : "Sample events are still being processed. "}
        Clear it before you go live so it doesn't mix with real catches.
      </span>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Clear sample data
      </Button>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Clear sample data?"
        actions={[{ label: "Clear sample data", tone: "danger", busy, onClick: clear }]}
      >
        Removes the sample incidents, their events and the sample attackers from this project. Real
        events, test hits and your settings stay.
      </Modal>
    </div>
  );
}
