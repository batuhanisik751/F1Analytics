// SPEC §3.4 — site palette and the ECharts theme. Dark-only; no toggle.
// Team and compound colours are NEVER hard-coded here for real data: they come
// from the database (session_teams / compound_colours). The fallbacks below are
// only for a compound or team missing from a colour map.

// v1.5 — the broadcast timing-tower palette. Must stay in step with app/globals.css:
// these values are what ECharts paints with, the CSS tokens are what the DOM paints with.
export const PALETTE = {
  bg: "#08080A",
  fg: "#F4F4F7",
  grid: "#26262E",
  accent: "#E10600",
  surface: "#121216",
  raised: "#1A1A20",
  muted: "#8B8B97",
  // Delta colours off the timing tower. These ENCODE meaning (fastest / personal best /
  // slower) and must not be reused as decoration.
  fastest: "#B45AF2",
  personal: "#00D26A",
  slower: "#FFD500",
} as const;

export const COMPOUND_FALLBACK: Record<string, string> = {
  SOFT: "#e8474b",
  MEDIUM: "#e8c547",
  HARD: "#ede6dc",
  INTERMEDIATE: "#4baa5e",
  WET: "#3c7fd6",
  UNKNOWN: "#7a736b",
  "TEST-UNKNOWN": "#434649",
};

export const TEAM_FALLBACK: string = PALETTE.accent;

const axisCommon = {
  axisLine: { lineStyle: { color: PALETTE.grid } },
  axisTick: { lineStyle: { color: PALETTE.grid } },
  axisLabel: { color: PALETTE.fg, fontSize: 12 },
  nameTextStyle: { color: PALETTE.muted, fontSize: 12 },
  splitLine: { lineStyle: { color: PALETTE.grid, type: "dashed" as const } },
  splitArea: { show: false },
};

// Registered once as 'f1dark' by components/charts/EChart.tsx.
export const f1darkTheme = {
  backgroundColor: "transparent",
  textStyle: { color: PALETTE.fg },
  // Default series ramp for charts that carry no team colour of their own.
  color: [PALETTE.accent, PALETTE.fastest, PALETTE.personal, PALETTE.slower, "#3C8CE0", PALETTE.muted],
  title: {
    textStyle: { color: PALETTE.fg, fontWeight: 600 },
    subtextStyle: { color: PALETTE.muted },
  },
  legend: {
    textStyle: { color: PALETTE.fg },
    pageTextStyle: { color: PALETTE.fg },
    pageIconColor: PALETTE.fg,
    pageIconInactiveColor: PALETTE.grid,
    inactiveColor: PALETTE.grid,
  },
  tooltip: {
    backgroundColor: PALETTE.raised,
    borderColor: PALETTE.grid,
    borderWidth: 1,
    textStyle: { color: PALETTE.fg },
    axisPointer: {
      lineStyle: { color: PALETTE.muted },
      crossStyle: { color: PALETTE.muted },
    },
  },
  categoryAxis: axisCommon,
  valueAxis: axisCommon,
  logAxis: axisCommon,
  timeAxis: axisCommon,
  dataZoom: {
    textStyle: { color: PALETTE.muted },
    borderColor: PALETTE.grid,
    fillerColor: "rgba(225, 6, 0, 0.16)",
    handleStyle: { color: PALETTE.accent, borderColor: PALETTE.accent },
    dataBackground: {
      lineStyle: { color: PALETTE.grid },
      areaStyle: { color: PALETTE.surface },
    },
  },
  markLine: { lineStyle: { color: PALETTE.fg } },
  line: { smooth: false, symbolSize: 4 },
  bar: { itemStyle: { borderColor: PALETTE.bg } },
  scatter: { symbolSize: 4 },
  boxplot: { itemStyle: { borderColor: PALETTE.grid } },
};
