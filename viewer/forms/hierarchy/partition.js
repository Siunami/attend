import { canvas, formLabel, hierarchyDepthById, number, records, selectable, selectedClass, svgElement, text, truncateToWidth } from "../shared.js";

function rectangles(nodes, mode) {
  if (nodes.every((node) => [node.x0, node.x1, node.y0, node.y1].every((value) => Number.isFinite(Number(value))))) {
    return nodes.map((node) => ({ node, x0: number(node.x0), x1: number(node.x1), y0: number(node.y0), y1: number(node.y1) }));
  }
  const depths = hierarchyDepthById(nodes);
  const maxDepth = Math.max(0, ...depths.values());
  const byId = new Map(nodes.map((node) => [text(node.id ?? node.nodeId), node]));
  const children = new Map(nodes.map((node) => [text(node.id ?? node.nodeId), []]));
  const roots = [];
  for (const node of nodes) {
    const parentId = node.parentId ?? node.parent;
    if (parentId === undefined || parentId === null || !byId.has(text(parentId))) roots.push(node);
    else children.get(text(parentId)).push(node);
  }
  const result = [];
  const weight = (node) => Math.max(0, number(node.total ?? node.value, 1)) || 1;
  if (mode === "icicle") {
    const place = (node, x0, x1) => {
      const depth = depths.get(text(node.id ?? node.nodeId)) ?? 0;
      result.push({ node, x0, x1, y0: depth / (maxDepth + 1), y1: (depth + 1) / (maxDepth + 1) });
      const descendants = children.get(text(node.id ?? node.nodeId)) ?? [];
      const total = descendants.reduce((sum, child) => sum + weight(child), 0) || 1;
      let cursor = x0;
      descendants.forEach((child, index) => {
        const next = index === descendants.length - 1 ? x1 : cursor + (x1 - x0) * weight(child) / total;
        place(child, cursor, next);
        cursor = next;
      });
    };
    const total = roots.reduce((sum, root) => sum + weight(root), 0) || 1;
    let cursor = 0;
    roots.forEach((root, index) => {
      const next = index === roots.length - 1 ? 1 : cursor + weight(root) / total;
      place(root, cursor, next);
      cursor = next;
    });
    return result;
  }
  const place = (node, x0, x1, y0, y1, depth) => {
    result.push({ node, x0, x1, y0, y1 });
    const descendants = children.get(text(node.id ?? node.nodeId)) ?? [];
    const total = descendants.reduce((sum, child) => sum + weight(child), 0) || 1;
    let cursor = depth % 2 === 0 ? x0 : y0;
    descendants.forEach((child, index) => {
      const share = weight(child) / total;
      if (depth % 2 === 0) {
        const next = index === descendants.length - 1 ? x1 : cursor + (x1 - x0) * share;
        place(child, cursor, next, y0, y1, depth + 1);
        cursor = next;
      } else {
        const next = index === descendants.length - 1 ? y1 : cursor + (y1 - y0) * share;
        place(child, x0, x1, cursor, next, depth + 1);
        cursor = next;
      }
    });
  };
  const total = roots.reduce((sum, root) => sum + weight(root), 0) || 1;
  let cursor = 0;
  roots.forEach((root, index) => {
    const next = index === roots.length - 1 ? 1 : cursor + weight(root) / total;
    place(root, cursor, next, 0, 1, 0);
    cursor = next;
  });
  return result;
}

export function renderPartition(root, dataset, selection, mode) {
  const nodes = records(dataset, "nodes");
  const svg = canvas(root, dataset, mode === "icicle" ? "Hierarchy depth appears in horizontal layers; width encodes additive value." : "Nested area encodes additive branch totals.");
  // Nested treemap rects share top edges, so an ancestor's label lands exactly on
  // its first child's; containment already names the branches, so only leaves label.
  const branchIds = new Set(
    nodes
      .map((node) => node.parentId ?? node.parent)
      .filter((value) => value !== undefined && value !== null)
      .map((value) => text(value)),
  );
  rectangles(nodes, mode).forEach(({ node, x0, x1, y0, y1 }, index) => {
    const normalized = Math.max(x0, x1, y0, y1) <= 1.000001;
    const x = normalized ? 45 + x0 * 870 : x0;
    const y = normalized ? 35 + y0 * 365 : y0;
    const width = normalized ? Math.max(1, (x1 - x0) * 870 - 1) : Math.max(1, x1 - x0 - 1);
    const height = normalized ? Math.max(1, (y1 - y0) * 365 - 1) : Math.max(1, y1 - y0 - 1);
    svg.append(svgElement("rect", { x, y, width, height, class: selectedClass(node, selection, `${mode}-node ${mode}-node--${index % 4}`), ...selectable(node), "aria-label": `${formLabel(node)}: ${number(node.total ?? node.value)}` }));
    const labelable = height > 20 && (mode === "icicle" || !branchIds.has(text(node.id ?? node.nodeId)));
    const label = labelable ? truncateToWidth(formLabel(node), width - 10) : "";
    if (label) svg.append(svgElement("text", { x: x + 5, y: y + 15, class: `${mode}-label` }, label));
  });
}
