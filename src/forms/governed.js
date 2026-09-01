import * as form0 from "./rank/bar-list/index.js";
import * as form1 from "./distribution/strip/index.js";
import * as form2 from "./composition/hundred-bar/index.js";
import * as form3 from "./profile/parallel/index.js";
import * as form4 from "./passage-comparison/parallel-text/index.js";
import * as form5 from "./trend/line/index.js";
import * as form6 from "./timeline/interval/index.js";
import * as form7 from "./sequence/step-strip/index.js";
import * as form8 from "./relationship/scatter/index.js";
import * as form9 from "./matrix/heatmap/index.js";
import * as form10 from "./hierarchy/tidy/index.js";
import * as form11 from "./network/local/index.js";
import * as form12 from "./flow/sankey/index.js";
import * as form13 from "./mechanism/flowchart/index.js";
import * as form14 from "./region-map/choropleth/index.js";
import * as form15 from "./point-map/exact-points/index.js";
import * as form16 from "./field/sample-raster/index.js";
import * as form17 from "./collection-atlas/faceted-atlas/index.js";
import * as form18 from "./rank/dot-plot/index.js";
import * as form19 from "./rank/slopegraph/index.js";
import * as form20 from "./distribution/histogram/index.js";
import * as form21 from "./distribution/ecdf/index.js";
import * as form22 from "./composition/part-list/index.js";
import * as form23 from "./profile/profile-table/index.js";
import * as form24 from "./trend/period-bars/index.js";
import * as form25 from "./timeline/event-strip/index.js";
import * as form26 from "./sequence/state-ribbon/index.js";
import * as form27 from "./relationship/marginals/index.js";
import * as form28 from "./hierarchy/outline/index.js";
import * as form29 from "./hierarchy/icicle/index.js";
import * as form30 from "./hierarchy/treemap/index.js";
import * as form31 from "./region-map/region-symbols/index.js";
import * as form32 from "./field/contours/index.js";
import * as form33 from "./collection-atlas/contact-atlas/index.js";

export const GOVERNED_FORM_MODULES = Object.freeze([
  form0,
  form1,
  form2,
  form3,
  form4,
  form5,
  form6,
  form7,
  form8,
  form9,
  form10,
  form11,
  form12,
  form13,
  form14,
  form15,
  form16,
  form17,
  form18,
  form19,
  form20,
  form21,
  form22,
  form23,
  form24,
  form25,
  form26,
  form27,
  form28,
  form29,
  form30,
  form31,
  form32,
  form33,
]);

export function governedFormModule(familyId, memberId) {
  return GOVERNED_FORM_MODULES.find((module) => module.descriptor.familyId === familyId && module.descriptor.memberId === memberId) ?? null;
}

