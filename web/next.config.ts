import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The web app is its own npm project inside the monorepo; pin the Turbopack root
  // here so a stray lockfile higher up the tree is never picked as the workspace root.
  turbopack: { root: __dirname },
  // node-postgres uses Node-only APIs and libpg-query is a WASM build of the real
  // PostgreSQL parser (MODE3_SPEC §1.3); neither survives bundling. Keep both out of
  // the server bundle. Both are used only by app/api/ask/route.ts and lib/ask/*.
  serverExternalPackages: ["pg", "libpg-query"],
  // OPS_SPEC §4.3 — lib/ask/prompt.ts reads schema-doc.txt with readFileSync at request
  // time, which the bundler's file tracing cannot see. Without this line the ask route
  // deploys without its schema picture and fails on the first real question.
  outputFileTracingIncludes: { "/api/ask": ["./lib/ask/schema-doc.txt"] },
};

export default nextConfig;
