// SPEC §4.3 item 7 — TeammateBars + unpaired teams + the notebook's caveat.
import TeammateBars from "@/components/charts/TeammateBars";
import Caption from "@/components/ui/Caption";
import EmptyState from "@/components/ui/EmptyState";
import TeamDot from "@/components/ui/TeamDot";
import type { TeammateRow } from "@/lib/queries/race";
import type { ColourMap, TeamRef } from "@/lib/queries/shared";

export type TeammateSectionProps = {
  rows: TeammateRow[];
  unpaired: { team: TeamRef; reason: string }[];
  colours: ColourMap;
  reason?: string | null;
};

export const TEAMMATE_CAPTION =
  "Same car, so the gap is the cleanest available driver signal — but a single race is a noisy, confounded observation.";

function UnpairedList({ unpaired }: { unpaired: TeammateSectionProps["unpaired"] }) {
  if (unpaired.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 text-sm text-muted" aria-label="Teams without a comparable pair">
      {unpaired.map((u) => (
        <li key={u.team.teamId} className="flex items-center gap-2">
          <TeamDot colour={u.team.teamColour} />
          <span>
            no comparable pair: <span className="text-fg">{u.team.teamName}</span> — {u.reason}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function TeammateSection({
  rows,
  unpaired,
  colours,
  reason,
}: TeammateSectionProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <>
        <EmptyState title="No teammate comparison for this race" reason={reason} />
        <UnpairedList unpaired={unpaired} />
      </>
    );
  }
  return (
    <div className="rounded-lg border border-grid bg-surface p-3">
      <TeammateBars rows={rows} colours={colours} />
      <UnpairedList unpaired={unpaired} />
      <Caption>{TEAMMATE_CAPTION}</Caption>
    </div>
  );
}
