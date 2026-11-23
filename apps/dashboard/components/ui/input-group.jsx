"use client";

import { cn } from "@/lib/utils";
import { Search, X } from "lucide-react";
import { useRef } from "react";
import { Input } from "@/components/ui/input";

/*
 * agents/ui/components.md → Input / Search.
 * InputGroup: relative wrapper. InputGroupAddon: icon slot, absolute at left-2.5, never on the text.
 * InputGroupInput: the Input with pl-8 so the placeholder starts after the icon.
 */
function InputGroup({ className, ...props }) {
  return (
    <div
      data-slot="input-group"
      className={cn("relative flex w-full min-w-0 items-center", className)}
      {...props}
    />
  );
}

function InputGroupAddon({ className, align = "start", ...props }) {
  return (
    <span
      data-slot="input-group-addon"
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center text-muted-foreground [&>svg]:size-4",
        align === "end" ? "right-2.5" : "left-2.5",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }) {
  return <Input data-slot="input-group-control" className={cn("pl-8", className)} {...props} />;
}

/**
 * Search / filter input: leading icon, 32 px, clear (×) when filled, Esc clears.
 * API mirrors a native input: `onChange` gets an event-like `{ target: { value } }`;
 * `onValueChange(value)` is the plain-value alternative. Pass `aria-label` (or `label`).
 */
function SearchInput({
  value = "",
  onChange,
  onValueChange,
  placeholder = "Search…",
  label,
  className,
  inputClassName,
  icon: Icon = Search,
  ...props
}) {
  const ref = useRef(null);
  const emit = (v) => {
    onValueChange?.(v);
    onChange?.({ target: { value: v }, currentTarget: { value: v } });
  };
  const filled = value != null && String(value).length > 0;
  return (
    <InputGroup className={cn("max-w-sm", className)}>
      <InputGroupAddon>
        <Icon />
      </InputGroupAddon>
      <InputGroupInput
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={props["aria-label"] ?? label ?? placeholder.replace(/…$/, "")}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => emit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && filled) {
            e.preventDefault();
            emit("");
          }
        }}
        className={cn(filled && "pr-8", inputClassName)}
        {...props}
      />
      {filled ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            emit("");
            ref.current?.focus();
          }}
          className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </InputGroup>
  );
}

export { InputGroup, InputGroupAddon, InputGroupInput, SearchInput };
