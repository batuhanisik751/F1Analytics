// MODE3_SPEC §8.4 — "There's a proper page for this." The trust hierarchy made into navigation.
//
// OWNERSHIP NOTE: §8.1 puts this map in `lib/ask/render.ts`, which does not exist and is not this
// package's file (WP-5 reported it as a gap). The map is static and view-derived, so it lives here
// until render.ts lands and can export it instead; the UI reads it through one function.
export type AskPageLink = { href: string; label: string; why: string };

const VIEW_PAGES: { views: string[]; link: AskPageLink }[] = [
  {
    views: ["ask.pace_ranking", "ask.stints", "ask.race_moment", "ask.lap_status"],
    link: {
      href: "/",
      label: "the race page for that round",
      why: "shows clean-air pace with rank uncertainty",
    },
  },
  {
    views: ["ask.degradation_fits", "ask.optimal_stint", "ask.compound_degradation"],
    link: {
      href: "/",
      label: "the race page's degradation section",
      why: "fits per-compound degradation with its own sample counts",
    },
  },
  {
    views: ["ask.teammate_h2h", "ask.teammate_deltas", "ask.driver_season_summary"],
    link: {
      href: "/driver",
      label: "the driver page",
      why: "shows the teammate head-to-head with the laps each delta is built from",
    },
  },
  {
    views: [
      "ask.mode2_car_rating",
      "ask.mode2_driver_rating",
      "ask.mode2_driver_skill",
      "ask.mode2_driver_contrast",
      "ask.mode2_counterfactual",
      "ask.mode2_component",
      "ask.mode2_career_season",
      "ask.mode2_driver_rating_history",
    ],
    link: {
      href: "/constructor",
      label: "was it the car?",
      why: "separates driver from car with a fitted model and stated uncertainty",
    },
  },
  {
    views: ["ask.title_odds", "ask.title_clinch", "ask.constructor_standings", "ask.driver_standings"],
    link: {
      href: "/season/2025",
      label: "the season page",
      why: "carries the standings and the simulated title odds",
    },
  },
  {
    views: ["ask.preview_finish_order", "ask.preview_round", "ask.preview_backtest"],
    link: { href: "/", label: "the race preview", why: "was backtested before it was published" },
  },
];

/** The single most relevant precomputed page for a set of touched views, or null. */
export function pageLinkForViews(views: string[]): AskPageLink | null {
  for (const entry of VIEW_PAGES) {
    if (views.some((v) => entry.views.includes(v))) return entry.link;
  }
  return null;
}
