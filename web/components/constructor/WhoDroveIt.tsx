// MODE2_SPEC §5.1 slot 5 — "Who drove it": the constructor's drivers with their driver
// effect, its interval and their anchor class, so the decomposition is legible from the
// car's side too. §8.4.2: a `floating` driver's headline numeral is NOT rendered as a
// plain number — a chip replaces it, and the chip is the only thing there.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import Section from "@/components/ui/Section";
import Caption from "@/components/ui/Caption";
import TermTip from "@/components/ui/TermTip";

export type WhoDroveItRow = {
  driverId: string;
  label?: string;
  year: number;
  ratingPp: number;
  ratingLo: number;
  ratingHi: number;
  anchorClass: "anchored" | "component-anchored" | "floating";
  basis: "measured" | "by-analogy";
  componentLabel: string;
};

export type WhoDroveItProps = {
  rows: WhoDroveItRow[];
  ciLevel: number;
  emptyReason?: string;
};

// §3.3 one value, one unit: the column header carries "% of a lap", so the cells do not
// repeat it. The caption below the table says the same thing again in words.
const pp = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;

const ANCHOR_LABEL: Record<WhoDroveItRow["anchorClass"], string> = {
  anchored: "anchored",
  "component-anchored": "anchored within its group",
  floating: "level not measured",
};

export default function WhoDroveIt({
  rows,
  ciLevel,
  emptyReason = "partial: the driver-car model has not been fitted yet",
}: WhoDroveItProps): React.JSX.Element {
  const level = Math.round(ciLevel * 100);
  const notMeasured = rows.filter((r) => r.anchorClass === "floating").length;
  const columns: DataTableColumn<WhoDroveItRow>[] = [
    { key: "year", header: "Season", className: "tnum", render: (r) => r.year },
    { key: "driver", header: "Driver", render: (r) => r.label ?? r.driverId },
    {
      key: "rating",
      header: "Driver effect, % of a lap",
      align: "right",
      className: "tnum",
      render: (r) =>
        r.anchorClass === "floating" ? (
          <span className="rounded-full border border-dashed border-accent/70 px-2 py-0.5 text-xs text-accent">
            level not measured
          </span>
        ) : (
          pp(r.ratingPp)
        ),
    },
    {
      key: "band",
      header: `${level} % range, % of a lap`,
      align: "right",
      className: "tnum text-muted",
      render: (r) => `${pp(r.ratingLo)} to ${pp(r.ratingHi)}`,
    },
    {
      key: "anchor",
      // UX_SPEC §3.3 — "Identified" is model vocabulary for "did we pin this down?".
      header: "How well we pinned it down",
      render: (r) => (
        <span className={r.anchorClass === "floating" ? "text-accent" : "text-muted"}>
          {ANCHOR_LABEL[r.anchorClass]}
        </span>
      ),
    },
  ];

  return (
    <Section
      title="Who drove it"
      caption="The driver side of the same split: how much of this car's lap time was the driver, and how well that could be pinned down."
      collapsible
      storageKey="constructor:who-drove-it"
      summary={`${rows.length} driver-season${rows.length === 1 ? "" : "s"} in this car${notMeasured > 0 ? `, ${notMeasured} of them with a level we could not measure` : ""}.`}
    >
      {/* §​3.2 — the two model words a reader meets in this table, defined where they meet them. */}
      <p className="mb-3 text-sm text-muted">
        <TermTip term="component-anchored">Anchored within its group</TermTip> means we can
        rank this driver against the drivers a chain of team moves connects him to, but not
        against the whole grid.{" "}
        <TermTip term="island-driver">Level not measured</TermTip> means even that is out of
        reach: only his gap to his team-mate is measured.
      </p>
      <DataTable
        caption={`Every driver who raced this car, with the part of the lap the model attributes to the driver, the range around it, and how firmly it could be placed.`}
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.year}-${r.driverId}`}
        rowClassName={(r) => (r.basis === "by-analogy" ? "opacity-90" : undefined)}
        emptyReason={emptyReason}
      />
      <Caption>
        Every number is in percent of the race centre lap, negative is faster, and every
        band is the 5th–95th percentile. A driver marked &ldquo;level not measured&rdquo;
        never changed team inside 2024–2026, so his own results say nothing about how good
        his car was; only his gap to his team-mate is measured.
      </Caption>
    </Section>
  );
}
