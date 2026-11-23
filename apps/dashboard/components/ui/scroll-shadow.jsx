"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Horizontal scroller with edge shadows that appear only when there is more to scroll.
 * The region is keyboard-scrollable (tabIndex 0 + aria-label) and shows the focus ring.
 * `className` styles the scrolling element; `fadeFrom` is the surface colour the shadows fade from
 * (a Tailwind `from-*` class, default `from-card`).
 */
function ScrollShadow({ children, label, className, fadeFrom = "from-card" }) {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((p) => (p.left === left && p.right === right ? p : { left, right }));
  }, []);
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [update]);
  return (
    <div data-slot="scroll-shadow" className="relative min-w-0">
      <div
        ref={ref}
        role="region"
        onScroll={update}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-scrollable
        tabIndex={0}
        aria-label={label}
        className={cn(
          "min-w-0 overflow-x-auto [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r to-transparent transition-opacity duration-120",
          fadeFrom,
          edges.left ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l to-transparent transition-opacity duration-120",
          fadeFrom,
          edges.right ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

export { ScrollShadow, ScrollShadow as EdgeScroller };
