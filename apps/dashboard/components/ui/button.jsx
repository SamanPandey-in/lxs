import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/*
 * agents/ui/components.md → Button.
 * Sizes: sm 28 · default 32 · lg 36 · icon 32 (icon-sm 28, icon-lg 36, xs/icon-xs 24 kept for legacy callers).
 * Navigation: <Button render={<Link href="…" />} nativeButton={false}>Label</Button> (Base UI's asChild).
 * Loading: <Button loading>Block source</Button> → spinner + same label + disabled.
 * Disabled with a reason: <Button disabledReason="Nothing to export">Export CSV</Button> →
 *   aria-disabled (stays focusable/hoverable), clicks suppressed, tooltip + sr-only reason.
 */
// Focus: 2 px outline ring (offset 2) + a soft 4 px halo. Press: 1 px drop (motion-safe).
// Transitions are 150 ms on colours and transform only (visual-language.md §5, §8).
const buttonVariants = cva(
  "group/button inline-flex max-w-full min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-clip-padding text-base font-medium whitespace-nowrap select-none transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:translate-y-px focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:ring-4 focus-visible:ring-ring/15 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Solid + 1 px top highlight; light mode adds a 1 px darker bottom edge.
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.15),inset_0_-1px_0_rgb(0_0_0/0.12)] hover:bg-primary/90 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.15),inset_0_-1px_0_rgb(0_0_0/0.12)] hover:bg-destructive/90 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]",
        outline:
          "border-border bg-card text-foreground shadow-card hover:bg-muted aria-expanded:bg-muted dark:border-input/60 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]",
        secondary:
          "border-border bg-card text-foreground shadow-card hover:bg-muted aria-expanded:bg-muted dark:border-input/60 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]",
        ghost: "text-foreground hover:bg-muted aria-expanded:bg-muted",
        link: "h-auto! px-0! text-link underline-offset-4 hover:underline motion-safe:active:translate-y-0",
      },
      size: {
        default: "h-8 px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1 rounded-md px-2.5 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-4",
        icon: "size-8 p-0",
        "icon-xs": "size-6 rounded-md p-0 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-7 rounded-md p-0",
        "icon-lg": "size-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  nativeButton,
  render,
  loading = false,
  disabled,
  disabledReason,
  children,
  ...props
}) {
  const resolvedNativeButton =
    nativeButton !== undefined
      ? nativeButton
      : render
        ? typeof render === "object" &&
          render !== null &&
          "type" in render &&
          render.type === "button"
        : undefined;

  if (disabledReason && !loading) {
    // The caller's onClick is dropped on purpose: the click is suppressed.
    const { onClick: _suppressed, ...rest } = props;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ButtonPrimitive
              data-slot="button"
              data-variant={variant}
              data-size={size}
              className={cn(
                buttonVariants({ variant, size, className }),
                "cursor-not-allowed aria-disabled:pointer-events-auto",
              )}
              render={render}
              nativeButton={resolvedNativeButton}
              aria-disabled="true"
              onClick={(e) => e.preventDefault()}
              {...rest}
            />
          }
        >
          {children}
          <span className="sr-only">. {disabledReason}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      render={render}
      nativeButton={resolvedNativeButton}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : null}
      {children}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
