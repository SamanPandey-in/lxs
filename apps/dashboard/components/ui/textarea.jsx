import { cn } from "@/lib/utils";

/*
 * Matches Input: rounded-lg, border-input, bg-card, text-base (14 px; 16 px on mobile via
 * the one rule in globals.css), focus = ring-colour border + outline (2 px) + soft 4 px halo. Uses pl/pr (not px) so callers
 * can override one side (components.md → Gotchas 2).
 */
function Textarea({ className, ...props }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full min-w-0 rounded-lg border border-input bg-card py-2 pr-2.5 pl-2.5 text-base text-foreground transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-offset-0 focus-visible:outline-ring focus-visible:ring-4 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
