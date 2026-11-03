"use client";
import { Check, ChevronDown, CircleAlert, Copy, Inbox, Loader2 } from "lucide-react";
import Link from "next/link";
// Component vocabulary copied from the Genesis api-client (ui.jsx) and re-skinned for LXS.
// Card / StatTile / Modal / Drawer / Tabs / Skeleton / Switch / Dropdown are the shadcn (Base UI) primitives.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle, Card as ShadCard } from "@/components/ui/card";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton as ShadSkeleton } from "@/components/ui/skeleton";
import { Switch as ShadSwitch } from "@/components/ui/switch";
import { Tabs as ShadTabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopy } from "@/lib/hooks";
import { describeRule, INCIDENT_STATUS, LABEL, ruleName, SEVERITY } from "@/lib/labels";
import { TECHNIQUES } from "@/lib/mock";
import { cn } from "@/lib/utils";

/* ───────── pills & chips ───────── */
export function Pill({ tone, children, icon: Icon, solid, large, title, className }) {
  return (
    <span
      className={cn("pill", large && "pill-lg", className)}
      data-tone={tone ?? "dim"}
      data-solid={solid ? "true" : undefined}
      title={title}
    >
      {Icon && <Icon size={12} aria-hidden />}
      {children}
    </span>
  );
}

export function SeverityPill({ severity, large, score }) {
  const m = SEVERITY[severity] || SEVERITY.low;
  return (
    <Pill tone={m.ptone} large={large} title={m.hint} solid={severity === "critical"}>
      {m.label}
      {score != null ? ` ${score}` : ""}
    </Pill>
  );
}
export function LabelPill({ label, large }) {
  const m = LABEL[label] || LABEL.noise;
  return (
    <Pill tone={m.tone} large={large} title={m.hint}>
      {m.label}
    </Pill>
  );
}
export function StatusPill({ status }) {
  const m = INCIDENT_STATUS[status] || INCIDENT_STATUS.open;
  return <Pill tone={m.tone}>{m.label}</Pill>;
}

export function Chip({ children, op, title, href }) {
  const props = { className: "chip", "data-op": op, title };
  return href ? (
    // No prefetch: an incident can render a dozen of these.
    <Link href={href} prefetch={false} {...props}>
      {children}
    </Link>
  ) : (
    <span {...props}>{children}</span>
  );
}
export function techTitle(id) {
  const t = TECHNIQUES[id];
  return t ? `${id} · ${t.name} (${t.tactic})${t.desc ? `\n${t.desc}` : ""}` : id;
}
export function TechChip({ id, link = true }) {
  return (
    <Chip
      op="tech"
      title={techTitle(id)}
      href={link ? `/incidents?technique=${encodeURIComponent(id)}` : undefined}
    >
      {id}
    </Chip>
  );
}
export function RuleChip({ id }) {
  return (
    <Chip op="rule" title={`${ruleName(id)}: ${describeRule(id)}`}>
      {id}
    </Chip>
  );
}

/* ───────── layout ───────── */
export function PageHeader({ eyebrow, title, purpose, actions }) {
  return (
    <header className="page-head">
      <div className="grow">
        {eyebrow ? <div className="ds-eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {purpose && <p>{purpose}</p>}
      </div>
      {actions && (
        <div className="page-actions flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

// Solid card with an optional header row. `flush` renders children without body padding (for tables).
export function Card({ title, sub, right, children, flush, className }) {
  return (
    <ShadCard className={className}>
      {(title || right) && (
        <CardHeader className="border-b border-border pb-3">
          <div className="flex w-full items-center gap-2">
            <div className="grow min-w-0">
              <CardTitle className="text-[13px] font-semibold">{title}</CardTitle>
              {sub ? (
                <div className="mt-0.5 text-[11.5px] font-normal text-muted-foreground">{sub}</div>
              ) : null}
            </div>
            {right}
          </div>
        </CardHeader>
      )}
      {flush ? (
        <div className="min-w-0">{children}</div>
      ) : (
        <CardContent className="min-w-0">{children}</CardContent>
      )}
    </ShadCard>
  );
}

export function StatTile({ label, value, hint, tone, icon: Icon }) {
  return (
    <ShadCard className="py-4">
      <CardContent className="px-4 py-0">
        <div className="tile-label">
          {Icon && (
            <Icon size={14} aria-hidden style={{ color: tone ? `var(--${tone})` : undefined }} />
          )}
          {label}
        </div>
        <div className="tile-value" style={{ color: tone ? `var(--${tone})` : undefined }}>
          {value}
        </div>
        {hint && <div className="tile-hint">{hint}</div>}
      </CardContent>
    </ShadCard>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, children, action }) {
  return (
    <div className="empty">
      {Icon && (
        <div className="empty-icon">
          <Icon size={20} aria-hidden />
        </div>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function PageLoading({ label = "Loading data" }) {
  return (
    <div className="page-state" role="status">
      <span className="health-dot is-pending" />
      {label}
    </div>
  );
}

export function PageError({ error, onRetry, label = "Could not load this page" }) {
  return (
    <div className="page-error" role="alert">
      <div>
        <strong>{label}</strong>
        <p>{error?.message ?? "The platform could not be reached."}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
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
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )
      }
    >
      {error?.message ?? "Unknown error"}. Check that the LXS platform is running at the URL in
      Settings.
    </EmptyState>
  );
}

export const Skeleton = ({ h = 14, w = "100%", style }) => (
  <ShadSkeleton className="block" style={{ height: h, width: w, ...style }} />
);

export function TableSkeleton({ rows = 5 }) {
  return (
    <div
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
      aria-busy="true"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} h={16} w={`${90 - i * 6}%`} />
      ))}
    </div>
  );
}

/* ───────── fields, code ───────── */
export function Field({ label, hint, children, htmlFor }) {
  return (
    <label className="form-field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function CopyButton({ text, label = "Copy", className = "btn btn-sm copy-btn" }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      className={className}
      onClick={() => copy(text)}
      aria-label={`${label}: ${text.slice(0, 40)}`}
    >
      {copied ? <Check /> : <Copy />} {copied ? "Copied" : label}
    </button>
  );
}

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
  if (!hash) return <span className="faint mono">none</span>;
  const short = hash.length > n + 6 ? `${hash.slice(0, n)}…${hash.slice(-4)}` : hash;
  return (
    <button
      type="button"
      className="chip"
      title={`${hash} (click to copy)`}
      onClick={() => {
        navigator.clipboard?.writeText(hash);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {label ? <span className="faint">{label}</span> : null}
      {short}
      {done ? <Check size={11} /> : <Copy size={11} />}
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
      <SheetContent className="w-[min(560px,100vw)] gap-0 border-l border-border-strong bg-popover p-0 sm:max-w-[min(560px,100vw)]">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-[14px] font-semibold">{title}</SheetTitle>
        </SheetHeader>
        <div className="grow overflow-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

// actions: [{ label, tone: 'primary' | 'danger', disabled, busy, onClick }]. A Cancel button is added automatically.
export function Modal({ open, onClose, title, children, actions = [], wide = false }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className="gap-3 border border-border-strong bg-popover"
        style={
          wide
            ? { width: "min(920px, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)" }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle className="text-[14px] font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">{children}</div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {actions.map((a) => (
            <Button
              key={a.label}
              variant={a.tone === "danger" ? "destructive" : "default"}
              disabled={a.disabled}
              onClick={a.onClick}
            >
              {a.busy ? <Loader2 className="spin" /> : null}
              {a.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// tabs: [{ value, label, count }]
export function Tabs({ tabs, value, onChange }) {
  return (
    <ShadTabs value={value} onValueChange={onChange}>
      <TabsList
        variant="line"
        className="h-auto w-full min-w-0 max-w-full justify-start gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-transparent p-0 px-2"
      >
        {tabs.map((t) => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            className="min-w-max shrink-0 rounded-none border-b-2 border-transparent px-3 py-2 text-[13px] data-[selected]:border-brand data-[selected]:text-foreground"
          >
            {t.label}
            {t.count != null ? (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                {t.count}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </ShadTabs>
  );
}

export function Dropdown({ label, icon: Icon, items, variant }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn("btn", variant === "primary" && "btn-primary")}>
        {Icon ? <Icon /> : null}
        {label}
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {items.map((it) => (
          <DropdownMenuItem key={it.label} onClick={it.onClick}>
            {it.icon ? <it.icon size={14} /> : null}
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
        {cols.map((c) => (
          <th
            key={typeof c === "string" ? c : c.label}
            className={typeof c === "object" && c.num ? "num" : undefined}
            style={typeof c === "object" && c.num ? { textAlign: "right" } : undefined}
          >
            {typeof c === "string" ? c : c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export { Button };
