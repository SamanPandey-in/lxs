import { cn } from "@/lib/utils";

/* Soft shimmer: a gradient sweep moved by transform (motion-safe); static muted block otherwise. */
function Skeleton({ className, ...props }) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:-translate-x-full before:bg-linear-to-r before:from-transparent before:via-card/70 before:to-transparent motion-safe:before:animate-shimmer dark:before:via-foreground/5",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
