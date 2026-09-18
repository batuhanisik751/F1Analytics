// SIM_SPEC §5.2 — seeded PRNG and the distributions the engine draws from. Pure TypeScript.

/** mulberry32: 32-bit seeded generator, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The second, independent stream of §5.2 (random SC timeline) derived from the main seed. */
export function scSeed(seed: number): number {
  return (seed ^ 0x9e3779b9) >>> 0;
}

/**
 * A random stream with the §5.2 distributions. `normal()` is Box–Muller with both values used,
 * so the number of uniforms consumed per call is fixed (one pair per two normals).
 */
export class Rng {
  private readonly u: () => number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.u = mulberry32(seed);
  }

  /** Uniform in [0, 1). */
  uniform(): number {
    return this.u();
  }

  /** Standard normal (Box–Muller; the second value is cached and returned on the next call). */
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u1 = this.u();
    while (u1 <= 0) u1 = this.u(); // avoid log(0)
    const u2 = this.u();
    const r = Math.sqrt(-2 * Math.log(u1));
    const th = 2 * Math.PI * u2;
    this.spare = r * Math.sin(th);
    return r * Math.cos(th);
  }

  /** chi-square with integer df: the sum of df squared standard normals. */
  chi2(df: number): number {
    let s = 0;
    for (let i = 0; i < df; i++) {
      const z = this.normal();
      s += z * z;
    }
    return s;
  }

  /** Student t with integer df: z / sqrt(chi2(df) / df). */
  t(df: number): number {
    const z = this.normal();
    return z / Math.sqrt(this.chi2(df) / df);
  }

  /** Geometric on {1, 2, …}: ceil(ln(1 − u) / ln(1 − p)). p in (0, 1]; p >= 1 → always 1. */
  geometric(p: number): number {
    if (p >= 1) return 1;
    const u = this.u();
    const k = Math.ceil(Math.log(1 - u) / Math.log(1 - p));
    return k < 1 ? 1 : k;
  }
}
