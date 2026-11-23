"use client";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Inbox,
  RotateCw,
} from "lucide-react";
import Link from "next/link";
// Shared component vocabulary. Every export keeps its original name and props so pages keep
// working; the internals follow agents/ui/components.md. See "Implemented API" there.
import { Children, cloneElement, isValidElement, useId, useState } from "react";
import { Badge, Count } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card as ShadCard } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton, CommandCopy as InlineCommand } from "@/components/ui/command-copy";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  SelectContent,
  SelectItem,
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EdgeScroller, ScrollShadow } from "@/components/ui/scroll-shadow";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton as ShadSkeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/ui/sparkline";
import { Switch as ShadSwitch } from "@/components/ui/switch";
import { Tabs as ShadTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/lib/hooks";
import { describeRule, INCIDENT_STATUS, LABEL, ruleName, SEVERITY } from "@/lib/labels";
import { TECHNIQUES } from "@/lib/mock";
import { cn, relative } from "@/lib/utils";

/* ───────── badges (pills) ───────── */

// Legacy tone names (globals.css palette) → semantic badge tones.
const TONE = {
  ok: "ok",
  live: "ok",
  healed: "brand",
  brand: "brand",
  cache: "info",
  rejected: "info",
  drift: "warn",
  warn: "warn",
  bad: "bad",
  halted: "neutral",
  dim: "neutral",
  neutral: "neutral",
  info: "info",
  "sev-critical": "critical",
  "sev-high": "high",
  "sev-medium": "medium",
  "sev-low": "low",
};
const SEV_TONES = new Set(["critical", "high", "medium", "low"]);

/**
 * Generic badge. `tone` accepts the legacy names (ok, live, bad, drift, cache, halted, brand,
 * sev-*) and maps them to a semantic variant: sev-* → severity fill, live → status dot,
 * everything else → subtle tag tint. `solid` forces a filled badge; `variant` overrides.
 */
export function Pill({ tone, children, icon: Icon, solid, large, title, className, variant }) {
  const t = TONE[tone] ?? "neutral";
  const v =
    variant ?? (solid || SEV_TONES.has(t) ? "severity" : tone === "live" ? "status" : "tag");
  return (
    <Badge
      variant={v}
      tone={t}
      title={title}
      className={cn(large && "h-6 px-2 text-sm", className)}
    >
      {Icon && <Icon aria-hidden />}
      {children}
    </Badge>
  );
}

/** Severity: solid fill, sentence case. Optional `score` is appended ("Critical 92"). */
export function SeverityPill({ severity, large, score }) {
  const m = SEVERITY[severity] || SEVERITY.low;
  const tone = SEVERITY[severity] ? severity : "low";
  return (
    <Badge
      variant="severity"
      tone={tone}
      title={m.hint}
      className={cn("tabular-nums", large && "h-6 px-2 text-sm")}
    >
      {m.label}
      {score != null ? ` ${score}` : ""}
    </Badge>
  );
}

// Labels are tags, never severity colours (tokens.md §9).
const LABEL_TONE = { targeted: "brand", opportunistic: "info", noise: "neutral" };
export function LabelPill({ label, large }) {
  const m = LABEL[label] || LABEL.noise;
  return (
    <Badge
      variant="tag"
      tone={LABEL_TONE[label] ?? "neutral"}
      title={m.hint}
      className={cn(large && "h-6 px-2 text-sm")}
    >
      {m.label}
    </Badge>
  );
}

const STATUS_TONE = { open: "warn", acknowledged: "info", resolved: "ok", false_positive: "neutral" };
/** Status: 6 px dot + text, no border or background. */
export function StatusPill({ status }) {
  const m = INCIDENT_STATUS[status] || INCIDENT_STATUS.open;
  return (
    <Badge variant="status" tone={STATUS_TONE[status] ?? "warn"}>
      {m.label}
    </Badge>
  );
}

/**
 * Live / connecting / offline indicator: status dot + text. `pulse` adds a soft ping ring
 * around the dot for live states (motion-safe only; a plain dot otherwise).
 */
export function StatusDot({ tone = "neutral", children, className, title, pulse = false }) {
  return (
    <Badge
      variant="status"
      tone={TONE[tone] ?? tone}
      pulse={pulse}
      className={className}
      title={title}
    >
      {children}
    </Badge>
  );
}

export { Badge, Count, Kbd, KbdGroup, Sparkline };

/* ───────── inline mono values, tech IDs ───────── */

const monoLink =
  "inline-flex max-w-full items-center rounded-sm font-mono text-xs text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Inline mono value. op="tech" renders like a tech link; op="ip" is foreground mono;
 * anything else is a neutral mono tag. `href` makes it a real link.
 */
export function Chip({ children, op, title, href }) {
  const cls =
    op === "tech"
      ? monoLink
      : op === "ip"
        ? "inline-flex max-w-full items-center font-mono text-xs text-foreground"
        : "inline-flex h-5 max-w-full items-center gap-1 truncate rounded-sm bg-muted px-1.5 font-mono text-xs text-muted-foreground";
  return href ? (
    // No prefetch: an incident can render a dozen of these.
    <Link href={href} prefetch={false} className={cn(cls, op !== "tech" && "hover:text-foreground")} title={title}>
      {children}
    </Link>
  ) : (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function techTitle(id) {
  const t = TECHNIQUES[id];
  return t ? `${id} · ${t.name} (${t.tactic})${t.desc ? `\n${t.desc}` : ""}` : id;
}
function techSummary(id) {
  const t = TECHNIQUES[id];
  return t ? `${id} · ${t.name} · ${t.tactic}` : id;
}

/** ATT&CK technique ID: mono text-xs link (text-link, underline on hover) with a tooltip. */
export function TechChip({ id, link = true }) {
  const trigger = link ? (
    <Link
      href={`/incidents?technique=${encodeURIComponent(id)}`}
      prefetch={false}
      className={monoLink}
      aria-label={techSummary(id)}
    />
  ) : (
    <button type="button" className={cn(monoLink, "cursor-default text-foreground hover:no-underline")} />
  );
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{id}</TooltipTrigger>
      <TooltipContent>{techSummary(id)}</TooltipContent>
    </Tooltip>
  );
}

/** Up to `max` technique IDs, then "+N" (full list in its tooltip). */
export function TechList({ ids = [], max = 3, link = true, className }) {
  const shown = ids.slice(0, max);
  const rest = ids.slice(max);
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {shown.map((t) => (
        <TechChip key={t} id={t} link={link} />
      ))}
      {rest.length ? (
        <Tooltip>
          <TooltipTrigger
            type="button"
            className="cursor-default rounded-sm text-xs text-muted-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
            aria-label={`${rest.length} more: ${rest.join(", ")}`}
          >
            +{rest.length}
          </TooltipTrigger>
          <TooltipContent>{rest.join(", ")}</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function RuleChip({ id }) {
  const text = `${ruleName(id)}: ${describeRule(id)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="inline-flex cursor-default items-center rounded-sm font-mono text-xs text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label={`${id} · ${text}`}
      >
        {id}
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/** Relative time ("3 min ago") that re-renders every 5 s; full local time in the title. */
export function RelativeTime({ iso }) {
  const now = useNow(5000);
  return (
    <time dateTime={iso} title={iso ? new Date(iso).toLocaleString() : ""}>
      {relative(iso, now)}
    </time>
  );
}

/* ───────── layout ───────── */

/** h1 + one-line description + actions. `eyebrow` is accepted but not rendered (G6). */
// biome-ignore lint/correctness/noUnusedFunctionParameters: eyebrow kept for API compatibility
export function PageHeader({ eyebrow, title, purpose, actions }) {
  return (
    <header className="page-head flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em] text-balance text-foreground">
          {title}
        </h1>
        {purpose && <p className="mt-1 mb-0 max-w-[70ch] text-sm text-muted-foreground">{purpose}</p>}
      </div>
      {actions && (
        <div className="page-actions flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {actions}
        </div>
      )}
    </header>
  );
}

/**
 * Card with a one-row header: title (+ sub) left, `right` slot right. One border.
 * `flush` renders children without body padding (tables, lists).
 */
export function Card({ title, sub, right, children, flush, className }) {
  const head = Boolean(title || right);
  return (
    <ShadCard className={cn("gap-0 py-0", className)}>
      {head && (
        <div
          data-slot="card-header"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4 pb-3"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {title ? (
              <h2
                data-slot="card-title"
                className="m-0 min-w-0 text-base font-semibold tracking-tight text-foreground"
              >
                {title}
              </h2>
            ) : null}
            {sub ? <p className="m-0 min-w-0 text-sm text-muted-foreground">{sub}</p> : null}
          </div>
          {right ? <div className="flex min-w-0 flex-wrap items-center gap-2">{right}</div> : null}
        </div>
      )}
      {flush ? (
        <div data-slot="card-content" className="min-w-0 p-0">
          {children}
        </div>
      ) : (
        <div
          data-slot="card-content"
          className={cn("min-w-0 px-5 pb-5", head ? "pt-1" : "pt-5")}
        >
          {children}
        </div>
      )}
    </ShadCard>
  );
}

// "Nothing here" values render muted like 0 (tokens.md §9: zero is neutral).
const EMPTY_VALUES = new Set(["0", "—", "-", "", "Not configured", "None"]);
const isZero = (v) =>
  v == null || v === 0 || (typeof v === "string" && EMPTY_VALUES.has(v.trim()));
const pctFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/**
 * Delta chip: "+12 %" / "−8 %" in an ok/bad tag tint, neutral at 0. `good` says which direction
 * is good news ("up" | "down"); anything else keeps the chip neutral.
 */
function DeltaChip({ delta, good = "up", label = "vs previous period" }) {
  const n = Number(delta);
  const rounded = Math.round(n);
  const dir = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const tone =
    dir === "flat" || (good !== "up" && good !== "down") ? "neutral" : dir === good ? "ok" : "bad";
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : null;
  const text = `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${pctFmt.format(Math.abs(rounded))} %`;
  const spoken = `${dir === "up" ? "Up" : dir === "down" ? "Down" : "Unchanged,"} ${pctFmt.format(Math.abs(rounded))} % ${label}`;
  return (
    <Badge variant="tag" tone={tone} title={spoken} className="tabular-nums">
      {Icon ? <Icon aria-hidden /> : null}
      <span aria-hidden>{text}</span>
      <span className="sr-only">{spoken}</span>
    </Badge>
  );
}

/**
 * KPI tile (visual-language.md §6): icon in a 28 px muted tile beside the label → value
 * (`text-2xl` semibold, tracking-tight, tabular) → optional sparkline and hint.
 * 0, null/undefined (shown as "—"), "—" and "Not configured" render muted; `tone` only tints
 * the icon (and not for those).
 * `trend` (number[], oldest first) draws a 32 px Sparkline; `trendLabel` is its sr-only summary.
 * `delta` (percent) shows a +/− chip; `deltaGood` = "up" (default) | "down" | "none" picks the
 * ok/bad tint; `deltaLabel` completes the spoken text ("Up 12 % vs previous 12 h").
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
  icon: Icon,
  trend,
  trendLabel,
  delta,
  deltaGood = "up",
  deltaLabel,
}) {
  const zero = isZero(value);
  const hasTrend = Array.isArray(trend) && trend.length > 1;
  return (
    <ShadCard className="gap-3 px-4 py-4">
      <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
        {Icon && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon
              aria-hidden
              className="size-4"
              style={tone && !zero ? { color: `var(--${tone})` } : undefined}
            />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {delta != null && Number.isFinite(Number(delta)) ? (
          <DeltaChip delta={delta} good={deltaGood} label={deltaLabel} />
        ) : null}
      </div>
      <div className="flex min-w-0 items-end justify-between gap-3">
        <div
          className={cn(
            "min-w-0 text-2xl font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]",
            zero ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {value ?? "—"}
        </div>
        {hasTrend ? (
          <Sparkline data={trend} summary={trendLabel} className="mb-0.5 w-24 shrink-0" />
        ) : null}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </ShadCard>
  );
}

/** Icon in a 40 px tile → title → one sentence → one action. */
export function EmptyState({ icon: Icon = Inbox, title, children, action }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 px-6 py-10 text-center">
      {Icon && (
        <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <h3 className="m-0 text-base font-medium text-foreground">{title}</h3>
      {children && (
        <p className="m-0 max-w-[52ch] text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {children}
        </p>
      )}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Loading placeholder for a whole page: skeleton mirroring the list template. */
export function PageLoading({ label = "Loading data" }) {
  return <PageSkeleton label={label} />;
}

/** Inline page-level error with Retry. */
export function PageError({ error, onRetry, label = "Could not load this page" }) {
  return (
    <div
      role="alert"
      className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-card px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0">
          <strong className="text-base font-medium text-foreground">{label}</strong>
          <p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {error?.message ?? "The platform could not be reached."}
          </p>
        </div>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry, what = "data" }) {
  return (
    <EmptyState
      icon={CircleAlert}
      title={`Could not load ${what}`}
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden /> Retry
          </Button>
        )
      }
    >
      {error?.message ?? "Unknown error"}.
      {error?.status === 401 || error?.status === 403
        ? " The API answered, but refused this session."
        : " Check that the LXS platform is running."}
    </EmptyState>
  );
}

/* ───────── skeletons ───────── */

/** `h`/`w` accept numbers (px) or CSS lengths; data-driven sizes only. */
export const Skeleton = ({ h = 14, w = "100%", style, className }) => (
  <ShadSkeleton className={cn("block", className)} style={{ height: h, width: w, ...style }} />
);

/** Table-shaped skeleton: 36 px header row + 44 px body rows, `cols` columns. */
export function TableSkeleton({ rows = 5, cols = 4 }) {
  const widths = ["40%", "20%", "15%", "25%", "18%", "12%"];
  return (
    <div aria-busy="true" className="min-w-0">
      <div className="flex h-9 items-center gap-4 border-y border-border bg-muted/60 px-5">
        {Array.from({ length: cols }).map((_, c) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
          <Skeleton key={c} h={10} w={c === 0 ? "18%" : "10%"} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={r} className="flex h-11 items-center gap-4 border-b border-border px-5 last:border-b-0">
          {Array.from({ length: cols }).map((_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
            <Skeleton key={c} h={12} w={widths[(c + r) % widths.length]} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Page-shaped skeleton (template B: header + card with toolbar and table). */
export function PageSkeleton({ label = "Loading", rows = 6, cols = 4 }) {
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 flex-col gap-6">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-2">
        <Skeleton h={28} w="min(320px, 60%)" />
        <Skeleton h={16} w="min(520px, 85%)" />
      </div>
      <ShadCard className="gap-0 py-0">
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <Skeleton h={20} w={160} />
        </div>
        <div className="flex items-center gap-3 px-5 pb-3">
          <Skeleton h={32} w="min(384px, 100%)" />
          <Skeleton h={32} w={128} className="hidden sm:block" />
        </div>
        <TableSkeleton rows={rows} cols={cols} />
      </ShadCard>
    </div>
  );
}

/* ───────── fields, search, select, code ───────── */

const joinIds = (...ids) => {
  const out = [...new Set(ids.filter(Boolean).join(" ").split(/\s+/).filter(Boolean))];
  return out.length ? out.join(" ") : undefined;
};

/**
 * Label above, control, then helper text, which `error` replaces (patterns.md §6).
 * The single child control gets `id`, `aria-describedby` (→ the message) and, with `error`,
 * `aria-invalid` wired automatically; values the child already sets are kept.
 */
export function Field({ label, hint, error, children, htmlFor, id, className }) {
  const auto = useId();
  const only = Children.count(children) === 1 && isValidElement(children) ? children : null;
  const controlId = htmlFor ?? id ?? only?.props.id ?? auto;
  const msgId = `${controlId}-msg`;
  const msg = error || hint;
  const control = only
    ? cloneElement(only, {
        id: only.props.id ?? controlId,
        "aria-describedby": joinIds(only.props["aria-describedby"], msg ? msgId : null),
        "aria-invalid": only.props["aria-invalid"] ?? (error ? true : undefined),
      })
    : children;
  return (
    <div data-slot="field" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={controlId} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {control}
      {error ? (
        <p id={msgId} role="alert" className="m-0 text-xs text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export { SearchInput };

/**
 * shadcn Select with a native-like API, so `<select>` swaps in one line:
 *   <Select value={v} onChange={(e) => setV(e.target.value)} options={[{ value, label }]} aria-label="Decoy" />
 * `onValueChange(value)` also works. `size` = "default" (32) | "sm" (28).
 */
export function Select({
  value,
  onChange,
  onValueChange,
  options = [],
  placeholder,
  id,
  name,
  disabled,
  size = "default",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  "aria-invalid": ariaInvalid,
}) {
  const items = options.map((o) => ({ value: String(o.value), label: o.label }));
  return (
    <SelectRoot
      items={items}
      value={value == null ? null : String(value)}
      name={name}
      disabled={disabled}
      onValueChange={(v) => {
        onValueChange?.(v);
        onChange?.({ target: { value: v, name }, currentTarget: { value: v, name } });
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        aria-invalid={ariaInvalid}
        className={cn("min-w-32", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export { CopyButton };

/**
 * Command / short mono value with a Copy button. Single line → inline mono (CommandCopy in
 * components/ui/command-copy); multi-line → CodeBlock. Accepts `cmd` or `code`.
 */
export function CommandCopy({ cmd, code, label = "Copy command", className }) {
  const text = cmd ?? code ?? "";
  if (text.includes("\n")) return <CodeBlock label={label}>{text}</CodeBlock>;
  return <InlineCommand cmd={text} label={label} className={className} />;
}

export { Checkbox, EdgeScroller, ScrollShadow };

export function CodeBlock({ children, value, label, copy = true }) {
  const raw = value ?? children;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null, null, 2);
  return (
    <div className="code-block">
      <pre className="code" role="region" aria-label={label}>
        {text}
      </pre>
      {copy ? <CopyButton text={text} /> : null}
    </div>
  );
}

// Copyable short hash: reused for honeytoken ids, IOC values and source IPs.
export function HashChip({ hash, label, n = 10 }) {
  const [done, setDone] = useState(false);
  if (!hash) return <span className="text-muted-foreground">—</span>;
  const short = hash.length > n + 6 ? `${hash.slice(0, n)}…${hash.slice(-4)}` : hash;
  return (
    <button
      type="button"
      title={`${hash} (click to copy)`}
      aria-label={`Copy ${label ? `${label} ` : ""}${hash}`}
      className="group/hash inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm font-mono text-sm text-foreground hover:text-link focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={() => {
        navigator.clipboard?.writeText(hash);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {label ? <span className="font-sans text-muted-foreground">{label}</span> : null}
      <span className="truncate">{short}</span>
      {done ? (
        <Check className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <Copy className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}

export function Switch({ checked, onChange, label }) {
  return <ShadSwitch checked={checked} onCheckedChange={onChange} aria-label={label} />;
}

/* ───────── overlays (shadcn Sheet / Dialog / Tabs / DropdownMenu) ───────── */
export function Drawer({ open, onClose, title, children }) {
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent className="w-[min(560px,100vw)] gap-0 border-l border-border bg-popover p-0 sm:max-w-[min(560px,100vw)]">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="text-lg font-semibold">{title}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * actions: [{ label, tone: 'primary' | 'danger' | 'outline', disabled, busy, onClick }].
 * A Cancel button is added automatically; `hideCancel` drops it (single-action dialogs, e.g. a
 * one-time secret with just "Done"), `cancelLabel` renames it. `wide` = up to 920 px.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions = [],
  wide = false,
  hideCancel = false,
  cancelLabel = "Cancel",
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "gap-3 border border-border bg-popover",
          wide &&
            "w-[min(920px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]",
        )}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <div className="text-base text-muted-foreground">{children}</div>
        {hideCancel && !actions.length ? null : (
          <DialogFooter className="gap-2">
            {hideCancel ? null : (
              <Button variant="outline" onClick={onClose}>
                {cancelLabel}
              </Button>
            )}
            {actions.map((a) => (
              <Button
                key={a.label}
                variant={
                  a.tone === "danger" ? "destructive" : a.tone === "outline" ? "outline" : "default"
                }
                disabled={a.disabled}
                loading={a.busy}
                onClick={a.onClick}
              >
                {a.label}
              </Button>
            ))}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * URL-friendly tabs as a segmented control (visual-language.md §5). tabs: [{ value, label, count }].
 * The list hugs its content and scrolls on narrow screens; counts sit in a `Count` pill.
 * Pass the active panel's content as `children` to get the WAI-ARIA APG wiring (tab
 * `aria-controls` ↔ panel `role="tabpanel"` + `aria-labelledby`, both from Base UI); without
 * children only the tab list renders (old behaviour). `panelClassName` styles the panel,
 * `listClassName` the padded row around the list (default: card-inset `px-4 pt-4 md:px-5`).
 */
export function Tabs({
  tabs,
  value,
  onChange,
  children,
  panelClassName,
  listClassName,
  "aria-label": ariaLabel,
}) {
  return (
    <ShadTabs value={value} onValueChange={onChange} className="gap-0">
      <div
        className={cn(
          "min-w-0 overflow-x-auto overflow-y-hidden px-4 pt-4 md:px-5 [scrollbar-width:thin]",
          listClassName,
        )}
      >
        <TabsList aria-label={ariaLabel}>
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              {t.count != null ? (
                <Count className="h-4 min-w-4 bg-card px-1 group-data-active/tab:bg-muted dark:bg-muted dark:group-data-active/tab:bg-background">
                  {t.count}
                </Count>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {children != null ? (
        <TabsContent
          value={value}
          className={cn(
            "text-base focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
            panelClassName,
          )}
        >
          {children}
        </TabsContent>
      ) : null}
    </ShadTabs>
  );
}

export function Dropdown({ label, icon: Icon, items, variant }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant={variant === "primary" ? "default" : "outline"} />}
      >
        {Icon ? <Icon aria-hidden /> : null}
        {label}
        <ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {items.map((it) => (
          <DropdownMenuItem key={it.label} onClick={it.onClick}>
            {it.icon ? <it.icon size={14} aria-hidden /> : null}
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ───────── table primitives ───────── */
export function Table({ children, className }) {
  return (
    <div className="table-scroll">
      <table className={cn("native-table", className)}>{children}</table>
    </div>
  );
}
export function THead({ cols }) {
  return (
    <thead>
      <tr>
        {cols.map((c) => {
          const num = typeof c === "object" && c.num;
          return (
            <th
              key={typeof c === "string" ? c : c.label}
              scope="col"
              className={num ? "num text-right" : undefined}
            >
              {typeof c === "string" ? c : c.label}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

export { Button };
