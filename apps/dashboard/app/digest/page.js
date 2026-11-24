"use client";
import { DigestEmailToggle, DigestPreview } from "@/components/retention/digest";
import { Card, PageHeader } from "@/components/ui";

/** Weekly digest: what this week's email says, and whether you get it. */
export default function DigestPage() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Weekly digest"
        purpose="Sent Mondays at 09:00 UTC for the week before. Sample data and test hits are not counted."
      />
      <Card>
        <DigestEmailToggle />
      </Card>
      <DigestPreview />
    </div>
  );
}
