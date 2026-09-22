import { unstable_cache } from "next/cache";

// REVALIDATE_SPEC §1 — every read in lib/queries is wrapped in `cached()` and stored under one tag,
// so the nightly push can expire all of it with a single revalidateTag("data", { expire: 0 })
// (app/api/revalidate/route.ts). Pages stay force-dynamic (SPEC D20): the page renders per request,
// its data comes from this cache. The timer only bounds a missed hook; the hook is the invalidator.
//
// Off outside production (next dev shows a local ingest at once, tests see the plain function) and
// off under DATA_CACHE=0, the rollback switch (§7): a pass-through cannot throw. DATA_TTL_S must
// never be 0 — unstable_cache throws at wrap time on revalidate: 0.
export const DATA_TAG = "data";
export const DATA_TTL_S = 3600;

const ON = process.env.NODE_ENV === "production" && process.env.DATA_CACHE !== "0";

/** Wrap a query-layer read. `name` is `<module>.<export>`, unique per function (it is part of the key). */
export function cached<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  if (!ON) return fn;
  return unstable_cache(fn, [name], { tags: [DATA_TAG], revalidate: DATA_TTL_S });
}
