"use client";
import { ChartNoAxesColumn } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Sparkline lives in components/ui/sparkline (no recharts, so the ui barrel stays light).
export { Sparkline } from "@/components/ui/sparkline";

/** Small inline SVG stacked bars, re-keyed to severities / labels. data: [{ label, <key>: n }] */
export function StackedBars({ data, keys, colors, height = 120 }) {
  const max = Math.max(1, ...data.map((d) => keys.reduce((n, k) => n + (d[k] || 0), 0)));
  const w = 100 / data.length;
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      role="img"
      aria-label="Stacked bar chart"
    >
      {data.map((d, i) => {
        let y = height - 2;
        return (
          <g key={d.label}>
            {keys.map((k) => {
              const h = ((d[k] || 0) / max) * (height - 6);
              y -= h;
              return h > 0 ? (
                <rect
                  key={k}
                  x={i * w + w * 0.14}
                  y={y}
                  width={w * 0.72}
                  height={h}
                  rx="0.6"
                  fill={colors[k]}
                >
                  <title>{`${d.label} · ${k}: ${d[k]}`}</title>
                </rect>
              ) : null;
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function Legend({ items }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2.5 shrink-0 rounded-sm"
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/**
 * True when a series has no points, or every value under `keys` is 0/missing.
 * Charts render `ChartEmpty` instead of empty axes in that case (components.md → Charts).
 */
export function isEmptySeries(data, keys) {
  if (!Array.isArray(data) || data.length === 0) return true;
  return data.every((d) => keys.every((k) => !Number(d?.[k])));
}

/** Empty state sized like the chart it replaces, so nothing shifts when data arrives. */
export function ChartEmpty({ title = "No data for this period", children, height = 200 }) {
  return (
    <div
      className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-lg bg-muted/40 px-6 text-center"
      style={{ height }}
    >
      <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-muted-foreground">
        <ChartNoAxesColumn className="size-5" aria-hidden />
      </div>
      <p className="m-0 text-base font-medium text-foreground">{title}</p>
      {children ? (
        <p className="m-0 max-w-[52ch] text-sm text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

const nf = new Intl.NumberFormat();
const fmtTick = (v) => nf.format(v);
const tick = { fill: "var(--muted-foreground)", fontSize: 12 };

const tipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  fontSize: "var(--text-xs)",
  fontVariantNumeric: "tabular-nums",
  color: "var(--popover-foreground)",
  boxShadow: "0 8px 24px rgb(0 0 0 / .18)",
};

/**
 * Stacked area timeline (recharts). series: [{ hour, noise, opportunistic, targeted }].
 * `empty` forces the empty state; by default it shows when every value is 0.
 */
export function ActivityArea({
  data,
  height = 220,
  empty,
  emptyTitle = "No events in the last 24 h",
  emptyHint,
}) {
  if (empty ?? isEmptySeries(data, ["noise", "opportunistic", "targeted"]))
    return (
      <ChartEmpty title={emptyTitle} height={height}>
        {emptyHint}
      </ChartEmpty>
    );
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="gNoise" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-4)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--chart-4)" stopOpacity={0.03} />
            </linearGradient>
            <linearGradient id="gOpp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-3)" stopOpacity={0.5} />
              <stop offset="100%" stopColor="var(--chart-3)" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="gTgt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-5)" stopOpacity={0.7} />
              <stop offset="100%" stopColor="var(--chart-5)" stopOpacity={0.08} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="hour" tick={tick} axisLine={false} tickLine={false} interval={3} />
          <YAxis
            tick={tick}
            axisLine={false}
            tickLine={false}
            width={44}
            allowDecimals={false}
            tickFormatter={fmtTick}
          />
          <Tooltip
            contentStyle={tipStyle}
            labelStyle={{ color: "var(--muted-foreground)" }}
            cursor={{ stroke: "var(--border-strong)" }}
          />
          <Area
            type="monotone"
            dataKey="noise"
            name="Noise"
            stackId="1"
            stroke="var(--chart-4)"
            strokeWidth={1.5}
            fill="url(#gNoise)"
          />
          <Area
            type="monotone"
            dataKey="opportunistic"
            name="Opportunistic"
            stackId="1"
            stroke="var(--chart-3)"
            strokeWidth={1.5}
            fill="url(#gOpp)"
          />
          <Area
            type="monotone"
            dataKey="targeted"
            name="Targeted"
            stackId="1"
            stroke="var(--chart-5)"
            strokeWidth={1.5}
            fill="url(#gTgt)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Single-series area (ingest rate). `empty` forces the empty state; by default it shows when
 * the series is missing or all zero.
 */
export function RateArea({
  data,
  dataKey = "events",
  xKey = "hour",
  height = 200,
  color = "var(--chart-1)",
  empty,
  emptyTitle = "No events in the last 24 h",
  emptyHint,
}) {
  if (empty ?? isEmptySeries(data, [dataKey]))
    return (
      <ChartEmpty title={emptyTitle} height={height}>
        {emptyHint}
      </ChartEmpty>
    );
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="gRate" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.45} />
              <stop offset="100%" stopColor={color} stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} tick={tick} axisLine={false} tickLine={false} interval={3} />
          <YAxis
            tick={tick}
            axisLine={false}
            tickLine={false}
            width={48}
            allowDecimals={false}
            tickFormatter={fmtTick}
          />
          <Tooltip
            contentStyle={tipStyle}
            labelStyle={{ color: "var(--muted-foreground)" }}
            cursor={{ stroke: "var(--border-strong)" }}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            name="Events"
            stroke={color}
            strokeWidth={1.8}
            fill="url(#gRate)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
