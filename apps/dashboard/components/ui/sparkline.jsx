"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

const nf = new Intl.NumberFormat();

/**
 * Tiny trend line for KPI tiles (visual-language.md §6): inline SVG, 32 px tall, `chart-1`
 * stroke over a 10 % gradient fill, no axes. The graphic is aria-hidden; `summary` is read out
 * instead (default: "Trend: from X to Y, peak Z"). An all-zero series draws a flat neutral line.
 * data: number[] (oldest first). Renders nothing with fewer than 2 points.
 */
function Sparkline({ data, height = 32, color = "var(--chart-1)", summary, className }) {
  const rawId = useId();
  const values = Array.isArray(data) ? data.map((v) => Number(v) || 0) : [];
  if (values.length < 2) return null;
  const gid = `spark-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const flat = max === min;
  const pad = 2; // keep the stroke inside the box
  const w = 100;
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => (flat ? height - pad : pad + (1 - (v - min) / (max - min)) * (height - pad * 2));
  const line = values
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`)
    .join(" ");
  const area = `${line} L${w},${height} L0,${height} Z`;
  const text =
    summary ??
    `Trend: from ${nf.format(values[0])} to ${nf.format(values[values.length - 1])}, peak ${nf.format(max)}`;
  const stroke = flat ? "var(--border-strong)" : color;
  return (
    <span className={cn("relative block min-w-0", className)} style={{ height }}>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        className="block overflow-visible"
      >
        {flat ? null : (
          <>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.1} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gid})`} stroke="none" />
          </>
        )}
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="sr-only">{text}</span>
    </span>
  );
}

export { Sparkline };
