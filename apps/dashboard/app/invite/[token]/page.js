"use client";
import { use } from "react";
import { InvitePage } from "@/components/auth-recovery";

export default function Page({ params }) {
  const { token } = use(params);
  return <InvitePage token={decodeURIComponent(token)} />;
}
