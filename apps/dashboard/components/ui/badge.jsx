import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * Semantic badge variants (agents/ui/components.md → Badge):
 *   severity  solid fill, sentence case. Severity only. `tone` = critical | high | medium | low
 *   status    6 px dot + text, no border/background. `tone` = ok | warn | bad | info | neutral.
 *             `pulse` adds a soft ping ring around the dot (motion-safe only) for live states.
 *   tag       subtle tint (10 % light, 15 % dark; caps 12 / 16 %), no border. `tone` = brand | info | ok | warn | bad | neutral
 *   count     muted pill, tabular numbers
 *   outline   border only (rare: versions, "Template")
 * Colours come from role tokens in globals.css (--sev-*, --ok, --warn, --link, …). Never uppercase.
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit max-w-full shrink-0 items-center gap-1.5 overflow-hidden text-xs font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&>svg]:pointer-events-none [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "h-5 rounded-md bg-primary px-1.5 text-primary-foreground",
        secondary: "h-5 rounded-md bg-secondary px-1.5 text-secondary-foreground",
        severity: "h-5 rounded-md bg-(--badge-c) px-1.5 text-(--sev-on)",
        status: "h-5 text-foreground",
        tag: "h-5 rounded-md bg-[color-mix(in_srgb,var(--badge-c)_10%,transparent)] px-1.5 text-(--badge-c) dark:bg-[color-mix(in_srgb,var(--badge-c)_15%,transparent)]",
        count:
          "h-5 min-w-5 justify-center rounded-full bg-muted px-1.5 text-muted-foreground tabular-nums",
        outline: "h-5 rounded-md border border-border px-1.5 text-muted-foreground",
        destructive: "h-5 rounded-md bg-destructive px-1.5 text-destructive-foreground",
        ghost: "h-5 rounded-md px-1.5 text-muted-foreground",
        link: "h-5 text-link underline-offset-4 hover:underline",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const TONE_VAR = {
  // severity
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  // roles
  ok: "var(--ok)",
  warn: "var(--warn)",
  bad: "var(--destructive)",
  info: "var(--link)",
  brand: "var(--primary)",
  neutral: "var(--muted-foreground)",
};

function Badge({
  className,
  variant = "default",
  tone,
  pulse = false,
  style,
  children,
  render,
  ...props
}) {
  const c = tone ? TONE_VAR[tone] || TONE_VAR.neutral : TONE_VAR.neutral;
  const content =
    variant === "status" ? (
      <>
        <span aria-hidden data-slot="badge-dot" className="relative flex size-1.5 shrink-0">
          {pulse ? (
            <span className="absolute inset-0 hidden rounded-full bg-(--badge-c) opacity-60 motion-safe:block motion-safe:animate-ping" />
          ) : null}
          <span className="relative size-1.5 rounded-full bg-(--badge-c)" />
        </span>
        {children}
      </>
    ) : (
      children
    );
  return useRender({
    defaultTagName: "span",
    props: mergeProps(
      {
        className: cn(badgeVariants({ variant }), className),
        style: { "--badge-c": c, ...style },
        children: content,
      },
      props,
    ),
    render,
    state: { slot: "badge", variant },
  });
}

/** Muted tabular count pill for tabs and nav. */
function Count({ className, children, ...props }) {
  return (
    <Badge variant="count" className={className} {...props}>
      {children}
    </Badge>
  );
}

export { Badge, Count, badgeVariants };
