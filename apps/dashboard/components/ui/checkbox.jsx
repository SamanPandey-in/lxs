"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * shadcn Checkbox on Base UI. 16 px box, 2 px focus-visible outline ring.
 * With `label`, the whole row (box + text, min 32 px tall) is the hit target:
 *   <Checkbox label="Hide simulated" checked={v} onCheckedChange={setV} />
 * Without `label`, pass `aria-label` or wrap it in your own <label>.
 */
function Checkbox({ className, label, description, labelClassName, ...props }) {
  const box = (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-card text-primary-foreground transition-colors duration-120 outline-none after:absolute after:-inset-1 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current [&>svg]:size-3.5"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            {state.indeterminate ? <MinusIcon aria-hidden /> : <CheckIcon aria-hidden />}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
  if (!label) return box;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Base UI renders the checkbox control inside this label
    <label
      data-slot="checkbox-label"
      className={cn(
        "flex min-h-8 cursor-pointer items-center gap-2 text-sm text-foreground has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50",
        description && "items-start py-1.5",
        labelClassName,
      )}
    >
      {box}
      {description ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{label}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </span>
      ) : (
        <span className="min-w-0">{label}</span>
      )}
    </label>
  );
}

export { Checkbox };
