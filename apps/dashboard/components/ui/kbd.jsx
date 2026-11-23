import { cn } from "@/lib/utils";

/*
 * Keyboard hint (visual-language.md §5): `rounded-md border bg-muted px-1.5 font-mono text-xs
 * text-muted-foreground`. Use one per key: <Kbd>⌘</Kbd><Kbd>K</Kbd>, or <KbdGroup> to space them.
 */
function Kbd({ className, ...props }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-muted px-1.5 font-mono text-xs font-normal text-muted-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }) {
  return (
    <span data-slot="kbd-group" className={cn("inline-flex items-center gap-1", className)} {...props} />
  );
}

export { Kbd, KbdGroup };
