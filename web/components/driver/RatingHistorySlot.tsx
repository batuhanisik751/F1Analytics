// MODE2_SPEC §8.5 slot 2 — rating over time. Caption C-HISTORY-1 is verbatim.
import RatingHistory from "@/components/charts/RatingHistory";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import type { RatingHistoryPoint } from "@/lib/queries/mode2";

export type RatingHistorySlotProps = {
  points: RatingHistoryPoint[];
  ciLevel: number;
  teamColour?: string;
};

export default function RatingHistorySlot({
  points,
  ciLevel,
  teamColour,
}: RatingHistorySlotProps): React.JSX.Element {
  if (points.length < 2) {
    return (
      <EmptyState
        title="Rating over time"
        reason="partial: fewer than two seasons of data"
      />
    );
  }
  return (
    <>
      <RatingHistory points={points} ciLevel={ciLevel} colour={teamColour} />
      {/* UX_SPEC §2.2 — the rating-over-time METHOD NOTE is one of the two blocks this page
          closes by default. §0: the text below is the original caption, complete and
          unshortened; only its visibility changed, and the summary line above it is new. */}
      <Disclosure
        summary="How each point is fitted, and why the band narrows only when a driver changes team"
        storageKey="driver:rating-history-method"
      >
        Each point re-fits the whole model using only the races up to the end of that season. The
        band gets narrower when a driver changes team, because a transfer is the only event that
        tells us how good his old car really was. For a driver who has never moved, more racing
        brings no more knowledge: his band never narrows, and it widens as each extra season
        teaches the model how far apart drivers really are.
      </Disclosure>
    </>
  );
}
