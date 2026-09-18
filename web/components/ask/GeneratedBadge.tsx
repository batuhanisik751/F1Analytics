// MODE3_SPEC §8.6 — the persistent `generated` badge, in the accent colour.
//
// WP-10: the `generated` variant now exists in `components/ui/StatusBadge.tsx`, where §9 WP-6
// says it belongs, so this is a thin delegation rather than a second pill. It stays as a named
// component because the ask surface uses it in five places and a wording change to the tooltip
// should happen once — but the geometry and the colour come from the shared badge, so the
// vocabulary cannot drift between the ask box and the race page.
import StatusBadge from "@/components/ui/StatusBadge";

export default function GeneratedBadge({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <StatusBadge
      status="generated"
      title="This answer was produced by a query Claude wrote just now, not by precomputed analytics."
      className={className}
    />
  );
}
