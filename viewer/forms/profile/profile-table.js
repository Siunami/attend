import { array, formLabel, format, htmlElement, markId, records, selectable, text } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "profile", memberId: "profile-table", fixtureId: "profile/profile-table/fixture-v1" });

export default function renderProfileTable(root, dataset) {
  const rows = records(dataset, "rows", ["entities"]);
  const declared = array(dataset.payload?.dimensions).map((dimension) => text(dimension.id ?? dimension.label ?? dimension));
  const dimensions = declared.length ? declared : [...new Set(rows.flatMap((row) => Object.keys(row.values ?? row.cells ?? {})))];
  root.replaceChildren();
  const region = htmlElement("div", "form-table-scroll");
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", dataset.title);
  region.setAttribute("tabindex", "0");
  region.setAttribute("data-form-id", `${dataset.familyId}/${dataset.memberId}`);
  const table = htmlElement("table", "profile-table");
  const head = htmlElement("thead");
  const headingRow = htmlElement("tr");
  headingRow.append(htmlElement("th", "profile-table__entity", dataset.payload?.entityLabel ?? "Entity"));
  dimensions.forEach((dimension) => headingRow.append(htmlElement("th", null, dimension)));
  head.append(headingRow);
  const body = htmlElement("tbody");
  rows.forEach((row) => {
    const tr = htmlElement("tr");
    tr.append(htmlElement("th", "profile-table__entity", formLabel(row)));
    dimensions.forEach((dimension) => {
      const sourceCells = row.values ?? row.cells ?? {};
      const cellValue = Array.isArray(sourceCells)
        ? sourceCells.find((candidate) => candidate?.dimension === dimension)
        : sourceCells[dimension];
      const cell = typeof cellValue === "object" && cellValue !== null ? cellValue : null;
      const missing = cellValue === undefined || cellValue === null || cell?.missing === true;
      const td = htmlElement("td", missing ? "is-missing" : null, missing ? "Missing" : format(cell?.value ?? cellValue));
      const identity = cell ?? row;
      if (!missing) {
        for (const [key, value] of Object.entries(selectable(identity))) td.setAttribute(key, value);
      }
      if (cell || markId(row)) td.setAttribute("aria-label", `${formLabel(row)}, ${dimension}: ${td.textContent}`);
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  region.append(table);
  root.append(region);
}
