"use client";
// MODE2_SPEC §8.6 slot 5 — the counterfactual control: two selects, nothing else.
//
// The control only changes the URL; every number on the page still comes from the
// precomputed tables via the server component (FD1 — the browser performs no inference).
// The default state is EMPTY with a prompt: never a pre-filled Verstappen-in-a-McLaren.
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export type CounterfactualOption = { id: string; label: string; disabled?: boolean };

export type CounterfactualControlProps = {
  year: number;
  drivers: CounterfactualOption[];
  /** Constructor-seasons inside this season, i.e. the cars available to swap into. */
  teams: CounterfactualOption[];
  selectedDriver: string | null;
  selectedTeam: string | null;
};

export default function CounterfactualControl({
  year,
  drivers,
  teams,
  selectedDriver,
  selectedTeam,
}: CounterfactualControlProps): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const go = (driver: string | null, team: string | null): void => {
    const q = new URLSearchParams();
    if (driver) q.set("driver", driver);
    if (team) q.set("car", team);
    const qs = q.toString();
    startTransition(() => {
      router.replace(`/season/${year}/was-it-the-car${qs ? `?${qs}` : ""}`, { scroll: false });
    });
  };

  // UX_SPEC §4.1 / §4.7 — a visible focus ring (the old `focus:outline-none` removed it) and a
  // 44 px minimum touch target.
  const selectClass =
    "min-h-[44px] rounded-md border border-grid bg-surface px-3 py-2 text-sm text-fg hover:border-muted focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Driver
        </span>
        <select
          className={selectClass}
          value={selectedDriver ?? ""}
          onChange={(e) => go(e.target.value || null, selectedTeam)}
        >
          <option value="">Pick a driver…</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id} disabled={d.disabled}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          In this {year} car
        </span>
        <select
          className={selectClass}
          value={selectedTeam ?? ""}
          onChange={(e) => go(selectedDriver, e.target.value || null)}
        >
          <option value="">Pick a car…</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id} disabled={t.disabled}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {selectedDriver || selectedTeam ? (
        <button
          type="button"
          className="min-h-[44px] rounded-md border border-grid px-3 py-2 text-sm text-muted hover:border-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => go(null, null)}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
