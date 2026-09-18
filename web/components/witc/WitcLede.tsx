// MODE2_SPEC §8.6 slot 1 — caption C-WITC-1, VERBATIM, the first thing on the page and
// above any chart. The first sentence is bold in the spec text and is bold here.
export default function WitcLede(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-grid bg-surface px-4 py-3">
      <p className="text-sm leading-relaxed text-muted">
        <strong className="text-fg">
          The team-mate gaps on this page are a measurement. The ordering across teams is
          a modelling choice.
        </strong>{" "}
        We checked how much each one moves when we fit the model a different but equally
        reasonable way: every team-mate gap moved by at most 0.04 % of a lap, and some
        drivers&apos; overall ratings moved by as much as 0.6 %. So compare two drivers in
        the same car with confidence, and treat the grid-wide order as our best estimate
        rather than a fact.
      </p>
    </div>
  );
}
