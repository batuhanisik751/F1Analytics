import type { MetadataRoute } from "next";

// OPS_SPEC §5.2 / §8 risk 4 — the site is public and every route is rendered per request
// from Neon's free tier. The telemetry pages are the heavy ones (~300 KB of rows each) and
// there are 71 of them; a polite crawler looping them hourly is ~15 GB/month against a 5 GB
// allowance. /ask is a form for people, not a page to index; /api is not a page at all.
// Both cliffs fail safe (Neon suspends, nothing is billed), but this keeps them from being
// reached by anything that reads robots.txt.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: ["/race/*/telemetry", "/ask", "/api/"] }],
  };
}
