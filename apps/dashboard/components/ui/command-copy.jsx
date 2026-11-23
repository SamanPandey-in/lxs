"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** Ghost `sm` button that copies `text`; shows "Copied" for a moment. */
function CopyButton({ text, label = "Copy", className }) {
  const [copied, copy] = useCopy();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("copy-btn", className)}
      onClick={() => copy(text)}
      aria-label={`${label}: ${String(text).slice(0, 40)}`}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Single-line command (or any short mono value): inline `font-mono text-sm` on a muted tint,
 * followed by a Copy button. Never a full-width code box for one line (components.md → Code).
 * Multi-line text goes to `CodeBlock` (the `@/components/ui` barrel export does that for you).
 */
function CommandCopy({ cmd, code, label = "Copy command", className }) {
  const text = cmd ?? code ?? "";
  return (
    <span
      data-slot="command-copy"
      className={cn("inline-flex max-w-full min-w-0 flex-wrap items-center gap-1", className)}
    >
      <code
        translate="no"
        className="min-w-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground [overflow-wrap:anywhere]"
      >
        {text}
      </code>
      <CopyButton text={text} label={label} />
    </span>
  );
}

export { CommandCopy, CopyButton };
