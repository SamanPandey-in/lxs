import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { PublicShell } from "@/components/AuthForm";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <PublicShell
      nav={
        <Button variant="ghost" render={<Link href="/login" />} nativeButton={false}>
          Log in
        </Button>
      }
      footer="A focused workspace for your security signals."
    >
      <section className="flex flex-col items-start gap-4 py-16 sm:my-auto lg:py-24">
        <h1 className="m-0 max-w-[20ch] text-3xl font-semibold lg:text-4xl tracking-[-0.01em] text-balance">
          See threats before they reach what matters.
        </h1>
        <p className="m-0 max-w-[60ch] text-lg text-pretty text-muted-foreground">
          Deploy believable decoys, detect targeted activity, and investigate it from one clear
          dashboard.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button size="lg" className="h-10" render={<Link href="/signup" />} nativeButton={false}>
            Create account <ArrowRight aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="h-10"
            render={<Link href="/login" />}
            nativeButton={false}
          >
            Log in
          </Button>
        </div>
      </section>
    </PublicShell>
  );
}
