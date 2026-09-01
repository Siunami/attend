import { canvas, extent, format, number, records, scale, selectable, selectedClass, svgElement } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "distribution", memberId: "ecdf", fixtureId: "distribution/ecdf/fixture-v1" });

const MAX_TARGET_ANCHORS = 64;

export default function renderEcdf(root, dataset, selection) {
  const steps = records(dataset, "steps", ["points"]);
  const domain = extent(steps.map((step) => number(step.value ?? step.x)));
  const x = scale(domain, [75, 915]);
  const y = scale([0, 1], [380, 35]);
  const svg = canvas(root, dataset, `${steps.length} cumulative steps; ties remain one evidenced step when projected together.`);
  let previousX = x(domain[0]);
  let previousShare = 0;
  const commands = [`M ${previousX} ${y(previousShare)}`];
  steps.forEach((step, index) => {
    const currentX = x(number(step.value ?? step.x));
    const share = number(step.share ?? step.cumulativeShare ?? step.p ?? ((index + 1) / Math.max(steps.length, 1)));
    commands.push(`H ${currentX} V ${y(share)}`);
    previousX = currentX;
    previousShare = share;
  });
  commands.push("H 915");
  svg.append(svgElement("path", { d: commands.join(" "), fill: "none", class: "ecdf-step ecdf-curve", "aria-hidden": "true" }));

  const targetSteps = steps.flatMap((step, sourceIndex) => (
    step.targetId ? [{ step, sourceIndex }] : []
  ));
  const stride = Math.max(1, Math.ceil(Math.max(0, targetSteps.length - 1) / (MAX_TARGET_ANCHORS - 1)));
  const anchors = targetSteps.filter(({ step }, index) => (
    index === targetSteps.length - 1
    || index % stride === 0
    || step.targetId === selection.selectedTargetId
  ));
  anchors.forEach(({ step, sourceIndex }, index) => {
    const share = number(step.share ?? step.cumulativeShare ?? step.p ?? ((sourceIndex + 1) / Math.max(steps.length, 1)));
    svg.append(svgElement("circle", {
      cx: x(number(step.value ?? step.x)),
      cy: y(share),
      r: index % 2 === 0 ? 4 : 3,
      class: selectedClass(step, selection, "ecdf-target-anchor"),
      ...selectable(step),
      "aria-label": `${format(step.value ?? step.x)}: ${format(share * 100)} percent at or below`,
    }));
  });
}
