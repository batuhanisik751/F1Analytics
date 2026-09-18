// MODE3_SPEC §1.4, §3.4, §8.7 — the generated result as a table. Always correct, which is why
// every render mismatch degrades to it.
//
// Columns are POSITIONAL: the wrap preserves duplicate output names (`SELECT 1 AS a, 2 AS a`), so
// rows arrive as arrays and the header de-duplicates for display only (`code`, `code (2)`).
// Every cell goes through `formatCell` into a React text node — no markdown, no HTML, ever.
import DataTable, { type DataTableColumn } from "@/components/ui/DataTable";
import { formatCell, numericColumns, uniqueHeaders } from "./format";

export const TABLE_ROW_LIMIT = 200;

type Row = { cells: unknown[]; i: number };

export default function AskTable({
  fields,
  rows,
  caption,
}: {
  fields: string[];
  rows: unknown[][];
  caption?: React.ReactNode;
}): React.JSX.Element {
  const headers = uniqueHeaders(fields);
  const numeric = numericColumns(fields, rows);
  const shown = rows.slice(0, TABLE_ROW_LIMIT);
  const columns: DataTableColumn<Row>[] = headers.map((h, i) => ({
    key: `${h}#${i}`,
    header: h,
    align: numeric[i] ? "right" : "left",
    className: numeric[i] ? "tnum" : undefined,
    render: (row) => formatCell(row.cells[i]),
  }));
  return (
    <>
      <DataTable
        columns={columns}
        rows={shown.map((cells, i) => ({ cells, i }))}
        rowKey={(r) => r.i}
        dense={shown.length > 12}
        caption={caption}
      />
      {rows.length > TABLE_ROW_LIMIT ? (
        <p className="mt-2 text-xs text-muted">
          Showing the first {TABLE_ROW_LIMIT} of {rows.length} rows.
        </p>
      ) : null}
    </>
  );
}
