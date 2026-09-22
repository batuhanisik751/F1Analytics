// REVALIDATE_SPEC §2 — the nightly push's hook. One tag, one hard expiry, one bearer secret.
//
// Every read in lib/queries is stored under DATA_TAG (lib/cache.ts). After a successful push,
// scripts/update_season.py POSTs here and every entry becomes a hard miss on its next read
// (`{ expire: 0 }`, §1's verified chain) — no stale serve, the first request after the push
// recomputes. The 3600 s timer in lib/cache.ts only bounds a missed hook.
//
// The route is OFF until REVALIDATE_SECRET is provisioned (≥ 32 chars, production only): 503,
// nothing revalidated. The header value is compared by digest and is never logged or echoed.

import { createHash, timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { DATA_TAG } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_SECRET_CHARS = 32;

type Deps = { revalidateTag: (tag: string, opts: { expire: number }) => void };

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** `Bearer <token>` → token, else null. The value never leaves this function except as a digest. */
function bearerOf(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer (\S+)$/.exec(header);
  return m ? m[1] : null;
}

/** Equal-length digests: no length leak, and timingSafeEqual cannot throw on a size mismatch. */
function tokenMatches(token: string | null, secret: string): boolean {
  if (token === null) return false;
  return timingSafeEqual(sha256(token), sha256(secret));
}

async function releaseIdOf(req: Request): Promise<number | null> {
  try {
    const body = (await req.json()) as { release_id?: unknown } | null;
    const v = body?.release_id;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null; // the body is optional and ignored except for this one field
  }
}

export async function handle(req: Request, deps: Deps = { revalidateTag }): Promise<Response> {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || secret.length < MIN_SECRET_CHARS) {
    return NextResponse.json({ code: "off" }, { status: 503 });
  }
  if (!tokenMatches(bearerOf(req), secret)) {
    return NextResponse.json({ code: "unauthorized" }, { status: 401 });
  }
  try {
    const release_id = await releaseIdOf(req);
    deps.revalidateTag(DATA_TAG, { expire: 0 });
    return NextResponse.json({
      ok: true,
      tag: DATA_TAG,
      expire: 0,
      release_id,
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("revalidate:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ code: "failed" }, { status: 500 });
  }
}

export const POST = (req: Request): Promise<Response> => handle(req);
