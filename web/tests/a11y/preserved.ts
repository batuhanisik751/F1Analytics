// UX_SPEC §0 / §6 — the matcher behind the caption-preservation test.
//
// Why not a plain substring test: v1.9 threads TermTip buttons and Disclosure summaries THROUGH
// existing sentences. "…ranked only against the 9 drivers…" is still on screen word for word, but
// "9 drivers" is now inside a <button>, so the one text node became three and `includes()` says
// the caption is gone. That false alarm is worse than no test: it trains a reviewer to ignore it.
//
// So: compare shingles of five consecutive words. An inserted element breaks at most the four
// shingles that straddle the seam; a deleted clause breaks a long unbroken run of them. Two
// broken shingles is the budget, which is one insertion — anything more is reported.
const WORDS = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .split(" ")
    .filter(Boolean);

export const SHINGLE = 5;
export const BUDGET = 2;

export type Match = { total: number; missing: number; firstGap: string | null };

export function measure(expected: string, pageText: string): Match {
  const want = WORDS(expected);
  const haystack = ` ${WORDS(pageText).join(" ")} `;
  if (want.length < SHINGLE) {
    const whole = ` ${want.join(" ")} `;
    const hit = haystack.includes(whole);
    return { total: 1, missing: hit ? 0 : 1, firstGap: hit ? null : want.join(" ") };
  }
  let missing = 0;
  let firstGap: string | null = null;
  for (let i = 0; i + SHINGLE <= want.length; i++) {
    const shingle = want.slice(i, i + SHINGLE).join(" ");
    if (!haystack.includes(` ${shingle} `)) {
      missing++;
      if (firstGap === null) firstGap = shingle;
    }
  }
  return { total: want.length - SHINGLE + 1, missing, firstGap };
}

/** Present, allowing for markup woven into the sentence — never allowing for a lost clause. */
export function isPreserved(expected: string, pageText: string): boolean {
  const { total, missing } = measure(expected, pageText);
  if (missing === 0) return true;
  return missing <= BUDGET && missing / total <= 0.4;
}

export function explain(expected: string, pageText: string): string {
  const { total, missing, firstGap } = measure(expected, pageText);
  return (
    `${missing}/${total} five-word runs absent; first gap: ${JSON.stringify(firstGap)}\n` +
    `    expected: ${JSON.stringify(expected.slice(0, 180))}`
  );
}
