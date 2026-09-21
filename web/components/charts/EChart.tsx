"use client";
// SPEC §3.4 — the ONE ECharts wrapper. Nothing else in the web app imports `echarts`.
// The container <div> renders on the server (stable layout); the canvas is drawn
// only on the client inside useEffect, so there is no hydration mismatch.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { EChartsOption } from "echarts";
import * as echarts from "echarts/core";
import {
  BarChart,
  BoxplotChart,
  CustomChart,
  LineChart,
  ScatterChart,
} from "echarts/charts";
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent, // TELEMETRY_SPEC v1.7 §5.0 — the track map's channel ramp
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { f1darkTheme } from "@/lib/theme";

echarts.use([
  BarChart,
  BoxplotChart,
  CustomChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  AxisPointerComponent,
  // v1.7 §5.0: in a tree-shaken `echarts/core` build an unregistered component is
  // SILENTLY IGNORED, so without this line the channel-painted track map would ship
  // unpainted and raise no error. MarkPoint is deliberately still not registered.
  VisualMapComponent,
  CanvasRenderer,
]);
echarts.registerTheme("f1dark", f1darkTheme);

// Re-exported so other chart components never import `echarts` themselves (SPEC §3.1):
// `clipRectByRect` is what a `custom` series' renderItem uses to clip bars to the grid (§4.3 gantt).
export const clipRectByRect = echarts.graphic.clipRectByRect;
export type { EChartsOption };

export type EChartProps = {
  /** Fully built by the caller; the wrapper only applies the theme. */
  option: EChartsOption;
  /** Container height; default 420 (px when a number). */
  height?: number | string;
  className?: string;
  /** Required; set as aria-label + role="img" on the container. */
  ariaLabel: string;
  /** Passed to setOption; default true. */
  notMerge?: boolean;
};

/**
 * UX_SPEC §4.6 — a reader who has asked their operating system for reduced motion gets no
 * chart animation, whatever the caller passed. Enforced HERE rather than in 25 call sites,
 * because a chart added later would otherwise silently reintroduce motion.
 *
 * `matchMedia` is read in an effect (never during render, which would break SSR) and the
 * change event is subscribed to, so toggling the OS setting takes effect without a reload.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// A media query is an external store, so it is read through useSyncExternalStore rather
// than mirrored into state from an effect: the value is available on the first client
// render (no flash of animated chart before the effect runs), the server snapshot keeps SSR
// deterministic, and there is no setState inside an effect for the React compiler to reject.
function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const readReducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(REDUCED_MOTION_QUERY).matches;
const serverReducedMotion = (): boolean => false;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion);
}

/** Strips every animation switch ECharts honours, including the per-series ones. */
export function withoutMotion(option: EChartsOption): EChartsOption {
  const series = (option as { series?: unknown }).series;
  const stilled = Array.isArray(series)
    ? series.map((s) => ({ ...(s as object), animation: false }))
    : series !== undefined
      ? { ...(series as object), animation: false }
      : undefined;
  return {
    ...option,
    animation: false,
    animationDuration: 0,
    animationDurationUpdate: 0,
    ...(stilled !== undefined ? { series: stilled as EChartsOption["series"] } : {}),
  };
}

export default function EChart({
  option,
  height = 420,
  className,
  ariaLabel,
  notMerge = true,
}: EChartProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const reducedMotion = useReducedMotion();

  // Mount: init once, keep it sized to the container, dispose on unmount.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, "f1dark", { renderer: "canvas" });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // (Re)apply the option whenever it changes. §4.6: under reduced motion the option is
  // stilled first, so no chart in the app animates for a reader who asked it not to.
  useEffect(() => {
    chartRef.current?.setOption(reducedMotion ? withoutMotion(option) : option, { notMerge });
  }, [option, notMerge, reducedMotion]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ height, width: "100%" }}
    />
  );
}
