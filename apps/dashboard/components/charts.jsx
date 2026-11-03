"use client";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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
          <g key={i}>
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
    <div className="row-wrap" style={{ gap: 14, fontSize: 12, color: "var(--text-dim)" }}>
      {items.map((it) => (
        <span key={it.label} className="row" style={{ gap: 6 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 3,
              background: it.color,
              display: "inline-block",
            }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

const tipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--text)",
  boxShadow: "0 8px 24px rgb(0 0 0 / .18)",
};

/** Stacked area timeline (recharts). series: [{ hour, noise, opportunistic, targeted }] */
export function ActivityArea({ data, height = 220 }) {
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
          <XAxis
            dataKey="hour"
            tick={{ fill: "var(--text-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={3}
          />
          <YAxis
            tick={{ fill: "var(--text-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            contentStyle={tipStyle}
            labelStyle={{ color: "var(--text-dim)" }}
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

/** Single-series area (ingest rate). */
export function RateArea({
  data,
  dataKey = "events",
  xKey = "hour",
  height = 200,
  color = "var(--chart-1)",
}) {
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
          <XAxis
            dataKey={xKey}
            tick={{ fill: "var(--text-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={3}
          />
          <YAxis
            tick={{ fill: "var(--text-faint)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            contentStyle={tipStyle}
            labelStyle={{ color: "var(--text-dim)" }}
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
