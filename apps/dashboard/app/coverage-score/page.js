"use client";
import { useState } from "react";
import { CoverageReport } from "@/components/retention/coverage";
import { ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { useAsync } from "@/lib/hooks";
import { retentionApi } from "@/lib/retention";
import { toast } from "@/lib/toast";

/** Every coverage check with what we saw, and every recommendation with why and how. */
export default function CoveragePage() {
  const { data, error, loading, reload } = useAsync(() => retentionApi.coverage(), []);
  const [local, setLocal] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const report = local ?? data;

  const reviewAllowlist = async () => {
    setReviewing(true);
    try {
      setLocal(await retentionApi.allowlistReviewed());
      toast("Allowlist marked as reviewed", "success", "The check counts for 90 days.");
    } catch (err) {
      toast("Could not mark the allowlist reviewed", "error", err.message);
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Coverage"
        purpose={
          report
            ? `${report.score} of ${report.max} points. ${
                report.recommendations.length
                  ? `${report.recommendations.length} ${report.recommendations.length === 1 ? "recommendation" : "recommendations"} below.`
                  : "Every check passes."
              }`
            : "How much of what LXS can see and stop is switched on for this project."
        }
      />
      {loading && !report ? (
        <div className="flex flex-col gap-4">
          <Skeleton h={120} className="rounded-xl" />
          <Skeleton h={320} className="rounded-xl" />
        </div>
      ) : error && !report ? (
        <ErrorState error={error} onRetry={reload} what="the coverage report" />
      ) : (
        <CoverageReport
          data={report}
          onReviewAllowlist={reviewAllowlist}
          reviewing={reviewing}
        />
      )}
    </div>
  );
}
