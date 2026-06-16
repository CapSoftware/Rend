/**
 * Shared comparison table used on the homepage and the /compare page.
 * Renders a desktop table and a stacked mobile card list from one data set.
 * Decorative marks are aria-labelled so the comparison stays accessible.
 */

type CmpCell = { kind: "yes" | "no" | "mid" } | { kind: "text"; value: string };

export const cmpColumns = ["Rend", "Minute-billed platforms", "Budget per-GB CDNs", "Roll your own"];

export const cmpRows: { feature: string; cells: CmpCell[] }[] = [
  {
    feature: "Pricing model",
    cells: [
      { kind: "text", value: "Delivery + storage by resolution" },
      { kind: "text", value: "Per minute, plus tiers" },
      { kind: "text", value: "Per GB, by region" },
      { kind: "text", value: "Whatever the bill says" },
    ],
  },
  {
    feature: "Plans",
    cells: [
      { kind: "text", value: "PAYG, Builder, Scale, Enterprise" },
      { kind: "text", value: "Monthly bundles" },
      { kind: "text", value: "Usage commitments" },
      { kind: "text", value: "Your own budget" },
    ],
  },
  {
    feature: "Encoding included",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "no" }, { kind: "no" }],
  },
  {
    feature: "Warmed opener for cold video",
    cells: [{ kind: "yes" }, { kind: "mid" }, { kind: "no" }, { kind: "no" }],
  },
  {
    feature: "Open source",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "no" }, { kind: "yes" }],
  },
  {
    feature: "Self-host, free forever",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "no" }, { kind: "yes" }],
  },
  {
    feature: "Bare-metal edge nodes",
    cells: [{ kind: "yes" }, { kind: "no" }, { kind: "mid" }, { kind: "no" }],
  },
  {
    feature: "Agent-ready, OpenAPI + llms.txt",
    cells: [{ kind: "yes" }, { kind: "mid" }, { kind: "no" }, { kind: "no" }],
  },
];

function CmpMark({ kind }: { kind: "yes" | "no" | "mid" }) {
  if (kind === "yes") {
    return (
      <svg className="cmp-mark cmp-yes" viewBox="0 0 24 24" role="img" aria-label="Yes">
        <path pathLength={1} d="M4 13 C7 15 9 17 11 20 C14 12 17 7 21 4" />
      </svg>
    );
  }
  if (kind === "no") {
    return (
      <svg className="cmp-mark cmp-no" viewBox="0 0 24 24" role="img" aria-label="No">
        <path pathLength={1} d="M6 6 C10 10 14 14 18 18" />
        <path pathLength={1} d="M18 6 C14 10 10 14 6 18" />
      </svg>
    );
  }
  return (
    <svg className="cmp-mark cmp-mid" viewBox="0 0 24 24" role="img" aria-label="Partial">
      <path pathLength={1} d="M4 13 C7 9 10 9 12 13 C14 17 17 17 20 13" />
    </svg>
  );
}

function renderCmpCell(cell: CmpCell) {
  if (cell.kind === "text") return <span>{cell.value}</span>;
  return <CmpMark kind={cell.kind} />;
}

export function ComparisonTable() {
  return (
    <>
      <div className="reveal mt-14 hidden overflow-x-auto md:block">
        <table className="cmp-table w-full min-w-[720px] border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="cmp-corner" aria-hidden="true" />
              {cmpColumns.map((col, i) => (
                <th key={col} scope="col" className={i === 0 ? "cmp-head cmp-head-rend" : "cmp-head"}>
                  <span className="relative inline-block px-1">
                    {col}
                    {i === 0 && (
                      <svg className="cmp-ring" viewBox="0 0 150 64" aria-hidden="true">
                        <path pathLength={1} d="M34 16 C70 5 120 8 134 26 C141 40 116 54 75 56 C34 58 9 47 13 30 C16 17 44 11 78 13" />
                      </svg>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cmpRows.map((row) => (
              <tr key={row.feature}>
                <th scope="row" className="cmp-feature">
                  {row.feature}
                </th>
                {row.cells.map((cell, i) => (
                  <td key={i} className={i === 0 ? "cmp-cell cmp-cell-rend" : "cmp-cell"}>
                    {renderCmpCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-12 flex flex-col gap-4 md:hidden">
        {cmpRows.map((row) => (
          <div key={row.feature} className="rounded-[16px] border border-line bg-card p-5">
            <p className="mb-3 font-head text-[18px] leading-snug text-ink">{row.feature}</p>
            <ul className="flex flex-col gap-1">
              {row.cells.map((cell, i) => (
                <li
                  key={i}
                  className={
                    i === 0
                      ? "flex items-center justify-between gap-4 rounded-[10px] bg-[rgba(22,21,19,0.05)] px-3 py-2"
                      : "flex items-center justify-between gap-4 px-3 py-2"
                  }
                >
                  <span className={i === 0 ? "text-[13.5px] font-medium text-ink" : "text-[13.5px] text-muted"}>
                    {cmpColumns[i]}
                  </span>
                  <span className={i === 0 ? "shrink-0 text-right text-[14px] font-medium text-ink" : "shrink-0 text-right text-[14px] text-ink"}>
                    {renderCmpCell(cell)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
