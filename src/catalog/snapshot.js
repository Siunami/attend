export const AUTHORED_FAMILY_ATLAS_CONTENT = Object.freeze([
  {
    "id": "annotated-specimen",
    "title": "Annotated specimen",
    "question": "What matters on this particular artifact, and exactly where?",
    "oneLine": "One primary artifact with restrained labels anchored to its native page, image, route, or time geometry.",
    "abstain": {
      "question": "Label the important parts of this photograph automatically",
      "why": "The photo records hue, brightness, subject class, and EXIF, but no object boxes or validated annotations. Placing callouts from a whole-image subject label would invent locations.",
      "instead": "The unannotated procedural frame with its observed EXIF and derived image fields in a table.",
      "note": "The family refuses spatial precision the source does not contain."
    },
    "members": [
      {
        "id": "callout-overlay",
        "name": "Anchored callout overlay",
        "when": "a few observed regions need names",
        "good": "Short labels sit inside or just outside the artifact with hairline leaders to exact boxes or points. The label is selectable evidence, not decoration.",
        "band": "2–12 callouts on one specimen",
        "lineage": "scientific plate annotation; Tufte's mapped pictures",
        "status": "core"
      },
      {
        "id": "layered-lens",
        "name": "Layered evidence lens",
        "when": "several annotation types share one artifact",
        "good": "Geometry, labels, confidence, and one selected layer use distinct visual weights. All layers preserve the same base scale and coordinate frame.",
        "band": "2–4 layers; ≤20 anchors visible at once",
        "lineage": "Tufte, layering and separation, <em>Envisioning Information</em>, pp. 53–65",
        "status": "core"
      },
      {
        "id": "detail-in-context",
        "name": "Detail in context",
        "when": "one small region must be read closely",
        "good": "A magnified inset repeats the selected region at a declared scale while its locator stays visible on the whole artifact.",
        "band": "1–3 insets; enlargement ratio printed",
        "lineage": "cartographic inset and scientific plate detail",
        "status": "core"
      },
      {
        "id": "before-after",
        "name": "Unannotated / annotated pair",
        "when": "unguided inspection should come first",
        "good": "The same specimen appears twice at constant scale, first untouched and then with restrained guidance. The reader can distinguish observation from editorial emphasis.",
        "band": "one pair; identical crop and scale",
        "lineage": "Tufte, <em>Visual Explanations</em>, pp. 16–18; mapped-picture essay",
        "status": "variant"
      },
      {
        "id": "time-anchored",
        "name": "Time-anchored annotation",
        "when": "the specimen is audio or video",
        "good": "Labels attach to exact time ranges on a waveform or frame strip. The transcript or clip at that interval opens directly.",
        "band": "2–12 labelled intervals per recording",
        "lineage": "graphical score and transcript-synced media",
        "status": "variant"
      },
      {
        "id": "opaque-callouts",
        "name": "Opaque callout boxes",
        "when": "never over evidence",
        "good": "White cards and dark outlines cover the specimen and create a second panel system. Use unboxed type, a light leader, and a subtle translucent wash only when needed.",
        "band": "rejected",
        "lineage": "presentation annotation default; Tufte critique",
        "status": "rejected"
      },
      {
        "id": "numbered-key",
        "name": "Detached numbered key",
        "when": "not when labels can fit",
        "good": "Numbers force repeated travel between artifact and legend and hide the meaning of the mark. Put the words at the region they describe.",
        "band": "rejected as default",
        "lineage": "museum and technical-manual convention",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "collection-atlas",
    "title": "Collection atlas",
    "question": "What is here, and how can I move through it?",
    "oneLine": "A complete visual index whose units remain recognizable and return to their native records.",
    "abstain": {
      "question": "Arrange my photos by visual similarity",
      "why": "The corpus has deterministic color and EXIF fields but no validated embedding, projection parameters, or stable similarity coordinates. Pretending that a handmade layout is model output would make proximity meaningless.",
      "instead": "A complete photo atlas ordered by observed capture time, with facets for camera, subject field, place, brightness, and hue.",
      "note": "The alternative still supports discovery while naming exactly why two frames are near one another."
    },
    "members": [
      {
        "id": "image-quilt",
        "name": "Image quilt",
        "when": "visual range is the first question",
        "good": "Gapless, equally treated frames expose repetition and outliers. Order is declared, borders are omitted, and every picture opens its record.",
        "band": "100–500 images per screen; ≥32 px color, ≥96 px for personal recognition",
        "lineage": "Tufte and Schwartz, ImageQuilts",
        "status": "core"
      },
      {
        "id": "contact-atlas",
        "name": "Contact atlas",
        "when": "capture order must remain visible",
        "good": "Frames follow recorded time at one scale. The sheet reveals bursts, near-duplicates, and the path to a keeper without sorting the sequence away.",
        "band": "12–200 frames per session",
        "lineage": "photographic contact sheet; Magnum practice",
        "status": "core"
      },
      {
        "id": "faceted-atlas",
        "name": "Faceted atlas",
        "when": "one observed category partitions the set",
        "good": "Separate strips for camera, kind, app, or source retain the same tile size. Facet names and counts sit directly above their objects.",
        "band": "2–12 facets; 5–200 items each",
        "lineage": "small multiples; Tufte, <em>Visual Explanations</em>, pp. 105–119",
        "status": "core"
      },
      {
        "id": "poster-atlas",
        "name": "Poster-frame atlas",
        "when": "each item is a video or recording",
        "good": "One scene-boundary frame, duration, date, and app identify each clip. A selected poster opens every keyframe and timecode.",
        "band": "12–120 clips; ≥160×90 per poster",
        "lineage": "storyboard and film index; Manovich, 2011",
        "status": "core"
      },
      {
        "id": "document-atlas",
        "name": "Document-page atlas",
        "when": "page shape and kind support discovery",
        "good": "One page thumbnail per document preserves page aspect and OCR regions. It is an index only; selecting it opens readable OCR and page geometry.",
        "band": "12–120 documents; ≥110×140 per page",
        "lineage": "contact sheet adapted to paged records",
        "status": "variant"
      },
      {
        "id": "similarity-field",
        "name": "Unexplained similarity field",
        "when": "never without a model record",
        "good": "UMAP or t-SNE coordinates have no ordinary axes and can change with features, seed, and parameters. Use only as an explicitly model-derived variant with all of those recorded.",
        "band": "rejected for this corpus",
        "lineage": "PixPlot and t-SNE image maps",
        "status": "rejected"
      },
      {
        "id": "thumbnail-treemap",
        "name": "Thumbnail treemap",
        "when": "never for equal-status objects",
        "good": "Arbitrary rectangle area and aggressive cropping imply quantity while making some items recognizable and others invisible. Use equal treatment and a declared order.",
        "band": "rejected",
        "lineage": "dashboard gallery convention",
        "status": "rejected"
      },
      {
        "id": "micro-tiles",
        "name": "Sub-recognition micro-tiles",
        "when": "never as an image index",
        "good": "Below the recognition floor, pictures become color swatches. Aggregate or page the collection rather than claim that a texture is a browseable atlas.",
        "band": "rejected below 32 px color or 96 px page recognition",
        "lineage": "thumbnail perception research",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "composition",
    "title": "Composition",
    "question": "What makes up this whole, and how stable are its shares?",
    "oneLine": "Parts measured against an explicit total, with every denominator printed.",
    "abstain": {
      "question": "How is my notes vault divided when notes may carry several tags?",
      "why": "Tags overlap, so their counts do not add to one whole. A 100% display would double-count notes and invent a denominator.",
      "instead": "Show a tag-by-folder matrix or a table of tag counts, with overlap stated.",
      "note": "The abstention renders every tag count and the number of multiply tagged notes as a table."
    },
    "members": [
      {
        "id": "part-list",
        "name": "Part-to-whole bar list",
        "when": "exact shares are primary",
        "good": "Each part gets a zero-based bar, its value, its share, and the total in the heading. This is the clearest default.",
        "band": "2-30 parts",
        "lineage": "Playfair's bars, 1786; Cleveland's position and length judgments, 1984",
        "status": "core"
      },
      {
        "id": "hundred-bar",
        "name": "100% bar",
        "when": "one compact whole",
        "good": "A single linear whole works when there are few, well-labelled parts. Labels sit on or beside segments; no legend is needed.",
        "band": "2-6 parts",
        "lineage": "Linear part-to-whole diagrams; modern statistical graphics",
        "status": "core"
      },
      {
        "id": "small-multiples",
        "name": "100% small multiples",
        "when": "several comparable wholes",
        "good": "One part order and one 0-100% frame make shifts in balance visible across periods or groups.",
        "band": "2-12 wholes, 2-6 parts",
        "lineage": "Tufte, small multiples, <em>EI</em>, ch. 4",
        "status": "core"
      },
      {
        "id": "composition-table",
        "name": "Composition table",
        "when": "parts are numerous",
        "good": "Counts, shares, and a compact bar sit in aligned columns. The table scrolls instead of dropping the tail.",
        "band": "8-100 parts",
        "lineage": "Statistical tables; Tufte's supertable",
        "status": "core"
      },
      {
        "id": "mosaic",
        "name": "Mosaic",
        "when": "two categorical partitions cross",
        "good": "Area represents joint count only after row and column margins are shown. Every rectangle states both categories.",
        "band": "2-5 by 2-5 cells",
        "lineage": "Friendly, mosaic displays, 1994",
        "status": "variant"
      },
      {
        "id": "marimekko",
        "name": "Marimekko",
        "when": "wholes differ in size and share",
        "good": "Column width carries each whole's absolute total while height carries its internal share. Use only when both readings are asked for.",
        "band": "2-8 wholes, 2-5 parts",
        "lineage": "Variable-width percentage charts, twentieth century",
        "status": "variant"
      },
      {
        "id": "pie",
        "name": "Pie or donut",
        "when": "never as the compiler default",
        "good": "Angles lack a common baseline, interior labels fail quickly, and a donut removes the one useful reference point. Use a linear whole.",
        "band": "rejected",
        "lineage": "Playfair, 1801; rejected by Tufte, <em>VDQI</em>, p. 178",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "distribution",
    "title": "Distribution",
    "question": "What is typical, how much does it vary, and what is unusual?",
    "oneLine": "Every observed value, or an honest count of values, arranged to reveal shape.",
    "abstain": {
      "question": "How interesting are the ideas in my voice memos?",
      "why": "‘interesting’ has no observed unit. Sentiment, novelty, or embedding distance would be proxy distributions and would answer different questions while looking precise.",
      "instead": "The memo passages themselves, ordered by date, with duration and a locator into the recording.",
      "note": "The family declines the invented score. Duration stays as metadata, not a claim about quality."
    },
    "members": [
      {
        "id": "strip",
        "name": "Strip or rug plot",
        "when": "the observations still fit",
        "good": "One tick or dot per value. Nothing is summarized away; stacking or a small deterministic jitter separates ties. Exact observations remain selectable.",
        "band": "5–400 observations",
        "lineage": "Tufte's rugplot, <em>VDQI</em>, p. 135",
        "status": "core"
      },
      {
        "id": "histogram",
        "name": "Histogram",
        "when": "marks collide and counts by interval matter",
        "good": "Adjacent bars count observations in declared equal-width bins. The baseline is zero, boundaries are printed, and one alternate binning is checked before publication.",
        "band": "50–100,000 observations; usually 8–40 bins",
        "lineage": "Pearson, 1895; Tufte redesign, <em>VDQI</em>, pp. 126–129",
        "status": "core"
      },
      {
        "id": "ecdf",
        "name": "Empirical cumulative distribution",
        "when": "percentiles or thresholds are the question",
        "good": "Every observation advances a step by exactly 1/n. No bins and no smoothing; any x answers ‘what share is at or below this value?’",
        "band": "20–1,000,000 observations",
        "lineage": "Empirical distribution function; Tukey's exploratory tradition",
        "status": "core"
      },
      {
        "id": "quartile",
        "name": "Quartile plot",
        "when": "many groups need compact comparison",
        "good": "Five values in a few hairlines: minimum, lower quartile, median, upper quartile, maximum. Tufte's erased box plot spends ink on the summary itself.",
        "band": "≥20 observations per group; 2–80 groups",
        "lineage": "Tukey box plot; Tufte quartile redesign, <em>VDQI</em>, pp. 123–125",
        "status": "core"
      },
      {
        "id": "small-multiple",
        "name": "Shared-scale distribution multiples",
        "when": "the distribution must be compared across groups",
        "good": "The same strip, histogram, or ECDF repeated with identical scales and boundaries. Data changes; the frame does not.",
        "band": "2–30 groups within one eyespan",
        "lineage": "Tufte, <em>Envisioning Information</em>, pp. 67–79",
        "status": "core"
      },
      {
        "id": "quantile-dots",
        "name": "Quantile dot plot",
        "when": "the distribution represents uncertainty",
        "good": "Twenty or fifty equally weighted dots make probability countable: five of twenty means one chance in four. Better decisions than a density silhouette when readers need thresholds.",
        "band": "20–100 dots",
        "lineage": "Fernandes, Walls, Munson, Hullman &amp; Kay, CHI 2018",
        "status": "core"
      },
      {
        "id": "stem-leaf",
        "name": "Stem-and-leaf",
        "when": "exact values and shape must coexist",
        "good": "The digits are both records and histogram marks. It preserves every value while revealing the distribution's silhouette.",
        "band": "20–300 rounded values",
        "lineage": "Tukey; Tufte, <em>VDQI</em>, p. 140",
        "status": "variant"
      },
      {
        "id": "beeswarm",
        "name": "Beeswarm",
        "when": "individual identity matters and ties are dense",
        "good": "Dots move only perpendicular to the measured axis, so their x-position stays exact. Use sparingly: collision packing adds visual motion but no second variable.",
        "band": "20–2,000 observations",
        "lineage": "one-dimensional scatter; Wilkinson's dot plots",
        "status": "variant"
      },
      {
        "id": "letter-value",
        "name": "Letter-value plot",
        "when": "tails matter and the sample is large",
        "good": "Nested quantile intervals continue beyond the quartiles, showing tail depth without a kernel. Each layer has an explicit probability mass.",
        "band": "≥1,000 observations",
        "lineage": "Hofmann, Wickham &amp; Kafadar, 2017",
        "status": "variant"
      },
      {
        "id": "violin",
        "name": "Violin plot",
        "when": "not by default",
        "good": "A kernel, bandwidth, mirrored silhouette, and area judgment intervene between observations and reader. If used for a very large sample, print the bandwidth and overlay observations or quantiles.",
        "band": "rejected as the default",
        "lineage": "Hintze &amp; Nelson, 1998",
        "status": "rejected"
      },
      {
        "id": "radial",
        "name": "Radial histogram",
        "when": "never for an ordinary distribution",
        "good": "Equal counts occupy unequal outer areas, baselines curve, and bins near twelve o'clock appear related. The circle adds no meaning unless the variable itself is cyclic.",
        "band": "—",
        "lineage": "spreadsheet polar charts",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "field",
    "title": "Field",
    "question": "How does a measured quantity vary across two dimensions?",
    "oneLine": "Samples, calibrated cells, contours, or vectors showing a continuous two-dimensional phenomenon.",
    "abstain": {
      "question": "Show a sound-frequency field for my voice memos",
      "why": "The synthetic memo records include duration, loudness, and transcript segments but no frequency-bin energy. A spectrogram generated from those fields would be decorative fiction.",
      "instead": "A memo table with duration and loudness, plus each recording's transcript-synced waveform.",
      "note": "The renderer names the missing measurement and returns to the available recording evidence."
    },
    "members": [
      {
        "id": "sample-raster",
        "name": "Sample raster",
        "when": "cells are directly observed",
        "good": "Each fixed cell shows a measured count or value; unobserved cells stay blank. Cell dimensions and the full value range are printed.",
        "band": "20–250,000 cells; ≥2 px per visible cell",
        "lineage": "statistical atlases and astronomical rasters; Tufte, <em>VDQI</em>, pp. 26–27",
        "status": "core"
      },
      {
        "id": "contours",
        "name": "Contour field",
        "when": "levels, ridges, or thresholds matter",
        "good": "Lines connect equal estimated values at declared intervals. Sample points remain visible so a contour cannot masquerade as direct measurement.",
        "band": "5–20 contour levels; samples dense relative to interval",
        "lineage": "Halley, 1701; Humboldt and Berghaus, nineteenth century",
        "status": "core"
      },
      {
        "id": "density",
        "name": "Kernel density field",
        "when": "point concentration is the phenomenon",
        "good": "A fixed bandwidth turns events into a records-per-area estimate. The bandwidth, denominator, and edge limitations are written on the figure.",
        "band": "200–1,000,000 points; bandwidth tested at ≥2 values",
        "lineage": "Rosenblatt, 1956; Parzen, 1962",
        "status": "core"
      },
      {
        "id": "vectors",
        "name": "Vector field",
        "when": "magnitude and direction are measured",
        "good": "Short strokes point with the local direction and scale modestly with magnitude. Orientation, length, and position all come from observed path tangents.",
        "band": "20–2,000 vectors; thin before sampling",
        "lineage": "Edmond Halley's trade-wind chart, 1686; Tufte, <em>VDQI</em>, p. 23",
        "status": "core"
      },
      {
        "id": "field-multiples",
        "name": "Shared-scale field multiples",
        "when": "one surface repeats by period or source",
        "good": "Domain, raster, bandwidth, and value scale remain fixed. Small panels expose change and sensitivity without animation.",
        "band": "2–12 panels",
        "lineage": "Los Angeles pollution slices; Tufte, <em>VDQI</em>, p. 42",
        "status": "variant"
      },
      {
        "id": "rainbow",
        "name": "Rainbow heatmap",
        "when": "never for ordered magnitude",
        "good": "Hue creates false boundaries and an arbitrary middle. A lightness-ordered ramp or a diverging ramp around a real critical value is easier to order.",
        "band": "rejected",
        "lineage": "default scientific palette; Tufte, <em>Envisioning Information</em>, pp. 81–95",
        "status": "rejected"
      },
      {
        "id": "unsupported-surface",
        "name": "Unsupported smooth surface",
        "when": "never",
        "good": "A smooth interpolation over sparse samples makes confidence look uniform. Keep sampled cells, gaps, and uncertainty visible instead.",
        "band": "rejected",
        "lineage": "GIS interpolation default",
        "status": "rejected"
      },
      {
        "id": "region-blur",
        "name": "Blurred choropleth",
        "when": "never",
        "good": "Smoothing values that belong to regions destroys their actual support and creates gradients across borders. Retain the bounded region map.",
        "band": "rejected",
        "lineage": "presentation-layer blur",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "flow",
    "title": "Flow",
    "question": "How does one additive quantity move between stages or places?",
    "oneLine": "A conserved count or amount, with band width proportional to what passes between named stages.",
    "abstain": {
      "question": "How do my active projects move from idea to done?",
      "why": "The project records have start and end dates, but no conserved item moving through named stages. A funnel would invent both the stages and the losses.",
      "instead": "A table of every project with its recorded start, end, kind, recent meetings, and recent mail.",
      "note": "The table reports the available process evidence without drawing an imaginary pipeline."
    },
    "members": [
      {
        "id": "sankey",
        "name": "Sankey diagram",
        "when": "the default for measured stages",
        "good": "Band width is the amount passed between named nodes; node totals and the source total reconcile.",
        "band": "2 to 5 stages; up to 30 nodes",
        "lineage": "Sankey, 1898",
        "status": "core"
      },
      {
        "id": "parallel",
        "name": "Parallel sets",
        "when": "rows change categorical membership",
        "good": "Each record follows one band through aligned categorical axes. Width counts records at every stage.",
        "band": "2 to 5 axes; up to 12 categories per axis",
        "lineage": "Bendix, Kosara, and Hauser, 2005",
        "status": "core"
      },
      {
        "id": "alluvial",
        "name": "Alluvial diagram",
        "when": "the same populations split across ordered states",
        "good": "Blocks and streams show how membership redistributes while keeping each period's total explicit.",
        "band": "2 to 8 states; up to 12 groups per state",
        "lineage": "Rosvall and Bergstrom, 2010",
        "status": "variant"
      },
      {
        "id": "chord",
        "name": "Bounded chord flow",
        "when": "pairwise two-way flows among a few entities",
        "good": "A circular arrangement can show reciprocal transitions when no natural left-to-right stage exists. Every entity is labelled.",
        "band": "3 to 10 entities",
        "lineage": "Circos, Krzywinski et al., 2009",
        "status": "variant"
      },
      {
        "id": "flow-map",
        "name": "Geographic flow",
        "when": "origin and destination geography matter",
        "good": "Bands join real places on one projection; width carries the additive amount and endpoints are named.",
        "band": "2 to 30 routes",
        "lineage": "Minard, 1840s to 1860s",
        "status": "variant"
      },
      {
        "id": "funnel",
        "name": "Funnel chart",
        "when": "never without explicit destinations",
        "good": "Centered trapezoids imply a continuous pipe while hiding where missing records went.",
        "band": "rejected",
        "lineage": "sales reporting",
        "status": "rejected"
      },
      {
        "id": "stream",
        "name": "Decorative streamgraph",
        "when": "never for staged accounting",
        "good": "A shifting baseline makes thickness hard to compare and surrounding layers move when one layer changes.",
        "band": "rejected",
        "lineage": "ThemeRiver and streamgraph descendants",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "hierarchy",
    "title": "Hierarchy",
    "question": "What contains what, and how do I reach a leaf?",
    "oneLine": "Containment and descent, with paths readable from root to leaf.",
    "abstain": {
      "question": "What is the true hierarchy of my tagged notes?",
      "why": "A note can carry several tags and link to notes in other folders. Choosing one tag as its parent would erase recorded memberships.",
      "instead": "A table of every folder and literal tag count, with note paths on selection.",
      "note": "The matrix preserves overlap instead of forcing a tree."
    },
    "members": [
      {
        "id": "outline",
        "name": "Indented outline",
        "when": "names and paths come first",
        "good": "Indentation states depth; reading order follows the source; long names remain horizontal.",
        "band": "5 to 5,000 nodes in a scrolling column",
        "lineage": "printed outlines and file browsers",
        "status": "core"
      },
      {
        "id": "tidy",
        "name": "Tidy node-link tree",
        "when": "branch shape and paths matter",
        "good": "Parents sit above children with deterministic spacing and direct labels at leaves.",
        "band": "5 to 500 nodes",
        "lineage": "Reingold and Tilford, 1981",
        "status": "core"
      },
      {
        "id": "icicle",
        "name": "Icicle partition",
        "when": "depth and additive size both matter",
        "good": "Aligned rectangles show depth by rows and leaf size by width. Labels stay horizontal.",
        "band": "2 to 5 levels; up to 300 nodes",
        "lineage": "Kruskal and Landwehr, 1983",
        "status": "variant"
      },
      {
        "id": "treemap",
        "name": "Treemap",
        "when": "space is tight and branch totals dominate",
        "good": "Containment and leaf size fill a fixed rectangle. Exact values must be printed or opened.",
        "band": "2 to 3 levels; up to 1,000 leaves",
        "lineage": "Shneiderman, 1991",
        "status": "variant"
      },
      {
        "id": "sunburst",
        "name": "Sunburst",
        "when": "never as the default hierarchy",
        "good": "Outer cells change area with radius, labels rotate, and paths are harder to trace than in an icicle.",
        "band": "rejected",
        "lineage": "radial partition layouts",
        "status": "rejected"
      },
      {
        "id": "circles",
        "name": "Circle packing",
        "when": "never for measured branch size",
        "good": "Packing wastes space and asks the reader to compare circle areas without a common scale.",
        "band": "rejected",
        "lineage": "packed enclosure diagrams",
        "status": "rejected"
      },
      {
        "id": "mind-map",
        "name": "Mind map",
        "when": "never for recorded containment",
        "good": "Free placement and decorative branches do not preserve a checkable parent relation.",
        "band": "rejected",
        "lineage": "concept drawing",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "matrix",
    "title": "Matrix",
    "question": "Which row and column pairs are strong, weak, or absent?",
    "oneLine": "Two categorical axes, one value per pair, reordered until the blocks become legible.",
    "abstain": {
      "question": "Which projects are urgent and important?",
      "why": "Urgent and important are judgments, not observed row and column fields in these files. A coloured 2 by 2 quadrant would place projects by an unrecorded opinion.",
      "instead": "A table of active projects with dated meetings, unanswered mail, and recorded end dates.",
      "note": "The table shows facts the reader can weigh without inventing quadrant coordinates."
    },
    "members": [
      {
        "id": "heatmap",
        "name": "Categorical heatmap",
        "when": "the default",
        "good": "A fixed cell for each pair, one lightness scale, and labels on both axes.",
        "band": "2 to 50 rows by 2 to 100 columns",
        "lineage": "Toussaint Loua, 1873; modern heatmaps",
        "status": "core"
      },
      {
        "id": "ordered",
        "name": "Reordered matrix",
        "when": "categories lack a natural order",
        "good": "Rows and columns sort by totals or a declared seriation rule so blocks become adjacent.",
        "band": "5 to 200 categories per axis",
        "lineage": "Bertin, <em>Semiology of Graphics</em>, 1967",
        "status": "core"
      },
      {
        "id": "correlation",
        "name": "Correlation matrix",
        "when": "the same measured fields repeat on both axes",
        "good": "The diagonal names the measures. Signed association uses one diverging scale and prints coefficients.",
        "band": "3 to 20 measures",
        "lineage": "statistical correlation tables",
        "status": "variant"
      },
      {
        "id": "adjacency",
        "name": "Adjacency matrix",
        "when": "a network is dense or larger than a node-link view",
        "good": "The same nodes appear on both axes. Direction and missing edges remain visible.",
        "band": "30 to 200 nodes",
        "lineage": "Bertin; matrix views of graphs",
        "status": "variant"
      },
      {
        "id": "upset",
        "name": "Intersection matrix",
        "when": "four or more overlapping sets",
        "good": "Dots name the sets in each intersection; aligned bars show intersection size without overlapping shapes.",
        "band": "4 to 20 sets; up to 50 intersections",
        "lineage": "Lex et al., UpSet, 2014",
        "status": "variant"
      },
      {
        "id": "bubble",
        "name": "Count matrix",
        "when": "zeros must dominate and magnitudes are coarse",
        "good": "A dot marks presence and area gives a rough count. Exact counts remain printed or selectable.",
        "band": "up to 40 by 40 cells",
        "lineage": "counts plots",
        "status": "variant"
      },
      {
        "id": "radial",
        "name": "Radial heatmap",
        "when": "never for a categorical matrix",
        "good": "Cells change area with radius, labels rotate, and rows stop sharing a common line.",
        "band": "rejected",
        "lineage": "decorative polar layouts",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "mechanism",
    "title": "Mechanism",
    "question": "Which recorded actions connect inputs, states, and outcomes?",
    "oneLine": "A verb on every arrow, evidence behind every step, and no causal claim the files cannot support.",
    "abstain": {
      "question": "Why were my slowest runs slow?",
      "why": "The workout records contain pace, distance, route, heart rate, and elevation. They do not record weather, illness, fatigue, injury, or training intent consistently. A fishbone would be a list of guesses attached to arrows.",
      "instead": "A table of the slowest runs with every recorded workout field and same-day running journal passages.",
      "note": "The table keeps observations separate from explanations the files cannot support."
    },
    "members": [
      {
        "id": "flowchart",
        "name": "Evidence flowchart",
        "when": "the default",
        "good": "Named inputs pass through verb-labelled transforms to outputs. Selection opens the rows handled by each step.",
        "band": "3 to 40 nodes",
        "lineage": "Gilbreth process charts, 1921",
        "status": "core"
      },
      {
        "id": "swimlane",
        "name": "Swimlane process",
        "when": "ownership changes between steps",
        "good": "Lanes name actors or systems while arrows name handoffs. Time still reads in one direction.",
        "band": "2 to 6 lanes; up to 40 steps",
        "lineage": "industrial process charts",
        "status": "core"
      },
      {
        "id": "states",
        "name": "Observed state transitions",
        "when": "a log records changes of state",
        "good": "Arrows count transitions that occurred. The figure makes no claim about why they occurred.",
        "band": "3 to 12 states",
        "lineage": "state-transition diagrams",
        "status": "variant"
      },
      {
        "id": "cycle",
        "name": "Evidence-backed cycle",
        "when": "the trace records a return to an earlier state",
        "good": "A closed path is allowed only when the event log contains the return edge and its frequency.",
        "band": "3 to 10 states",
        "lineage": "cyclic process diagrams",
        "status": "variant"
      },
      {
        "id": "fishbone",
        "name": "Fishbone diagram",
        "when": "not without coded causes",
        "good": "Possible causes gathered in a workshop are hypotheses, not evidence from the files.",
        "band": "rejected here",
        "lineage": "Ishikawa, 1968",
        "status": "rejected"
      },
      {
        "id": "concept",
        "name": "Pyramid or target diagram",
        "when": "never for file evidence",
        "good": "Geometric levels and centres add an order or importance relation that the source does not contain.",
        "band": "rejected",
        "lineage": "presentation templates",
        "status": "rejected"
      },
      {
        "id": "generic-arrows",
        "name": "Unlabelled causal arrows",
        "when": "never",
        "good": "A generic arrow can mean caused, sent, transformed, followed, resembled, or merely sat beside.",
        "band": "rejected",
        "lineage": "diagramming default",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "network",
    "title": "Network",
    "question": "What connects to what, and which paths pass between them?",
    "oneLine": "Recorded links among named items, shown locally when sparse and as a matrix when dense.",
    "abstain": {
      "question": "What is my whole notes vault about?",
      "why": "A global graph of 592 notes would mostly show link density and layout choices. It would not summarize the words, and the source stores no semantic similarity relation.",
      "instead": "A complete table of folders and subfolders with note counts, words, outgoing links, and incoming links.",
      "note": "The table uses every note and makes the four recorded quantities explicit."
    },
    "members": [
      {
        "id": "local",
        "name": "Focused node-link graph",
        "when": "the default",
        "good": "One named focus, its neighbours, and links among those neighbours. Position is deterministic and labels stay horizontal.",
        "band": "5 to 100 nodes; sparse edges",
        "lineage": "Moreno sociograms, 1934",
        "status": "core"
      },
      {
        "id": "arc",
        "name": "Arc diagram",
        "when": "nodes already have a meaningful order",
        "good": "Nodes stay on the order axis while arcs reveal short and long crossings.",
        "band": "5 to 100 nodes",
        "lineage": "Wattenberg, 2002",
        "status": "core"
      },
      {
        "id": "citation",
        "name": "Citation neighbourhood",
        "when": "edges are directed references",
        "good": "Older and newer works occupy dated columns; arrows point to the cited work.",
        "band": "5 to 80 works",
        "lineage": "citation graph analysis",
        "status": "variant"
      },
      {
        "id": "coattendance",
        "name": "Co-attendance network",
        "when": "edges mean repeated shared events",
        "good": "Line weight counts shared events and the edge opens every event. It does not claim friendship.",
        "band": "5 to 60 people",
        "lineage": "Moreno's sociometry",
        "status": "variant"
      },
      {
        "id": "hairball",
        "name": "Global force graph",
        "when": "never as an overview",
        "good": "Crossings, unlabeled nodes, and unstable positions hide the relations the view was meant to expose.",
        "band": "rejected",
        "lineage": "generic graph-view default",
        "status": "rejected"
      },
      {
        "id": "mind-map",
        "name": "Mind map",
        "when": "never for evidence",
        "good": "Freehand proximity and branch style carry opinions that do not exist in the source records.",
        "band": "rejected",
        "lineage": "brainstorm diagrams",
        "status": "rejected"
      },
      {
        "id": "hive",
        "name": "Hive plot",
        "when": "not without a domain axis rule",
        "good": "Axis assignment can dominate the result and demands expert decoding before a path can be read.",
        "band": "rejected",
        "lineage": "Krzywinski et al., 2012",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "passage-comparison",
    "title": "Passage comparison",
    "question": "What changed between these texts, and where exactly did it change?",
    "oneLine": "Readable passages aligned on a shared anchor, with source locators intact.",
    "abstain": {
      "question": "Which unrelated journal entry is most similar to this voice memo?",
      "why": "The local record has no declared alignment, and a semantic model would create one with uncertain meaning.",
      "instead": "Show the memo transcript and candidate journal passages as a labelled search result, not as a diff.",
      "note": "The abstention renders the original transcript and dated passages in one reading column."
    },
    "members": [
      {
        "id": "split-diff",
        "name": "Aligned split diff",
        "when": "two line-addressable versions",
        "good": "Old and new lines sit side by side with insertions and removals named in the gutter. Unchanged context remains readable.",
        "band": "2 versions, up to about 2,000 changed lines",
        "lineage": "Unix diff, 1974; modern code review",
        "status": "core"
      },
      {
        "id": "unified-diff",
        "name": "Unified diff",
        "when": "reading flow matters",
        "good": "One interleaved column preserves context and works at narrow widths. Prefixes and words label change in addition to colour.",
        "band": "2 versions, any readable file",
        "lineage": "GNU unified diff, 1990",
        "status": "core"
      },
      {
        "id": "synopsis",
        "name": "Aligned synopsis",
        "when": "short passages share sections",
        "good": "Two to four witnesses align by heading, verse, timestamp, or field. Missing passages remain explicit blank cells.",
        "band": "2-4 witnesses",
        "lineage": "Eusebian Canons; Hexapla, third century",
        "status": "core"
      },
      {
        "id": "parallel-text",
        "name": "Parallel text",
        "when": "source and rendering differ by medium",
        "good": "Scan and OCR, audio and transcript, or original and translation stay adjacent with shared locators.",
        "band": "2 witnesses, 1 reading column each",
        "lineage": "Polyglot books; diplomatic editions",
        "status": "core"
      },
      {
        "id": "layered-edition",
        "name": "Layered edition",
        "when": "more than four versions",
        "good": "One readable base text carries compact marks for revision events. Selecting a mark opens every version at that locus.",
        "band": "5-20 versions",
        "lineage": "Ben Fry, <em>Traces</em>, 2009",
        "status": "variant"
      },
      {
        "id": "change-fingerprint",
        "name": "Change fingerprint",
        "when": "the document is too long for an overview",
        "good": "One thin cell per block locates change density in reading order. It is always paired with the passage view.",
        "band": "100-100,000 blocks",
        "lineage": "TileBars, 1995; editor minimaps",
        "status": "variant"
      },
      {
        "id": "text-cloud",
        "name": "Word cloud comparison",
        "when": "never",
        "good": "Font area hides exact counts, long words look important, and no mark preserves the sentence where a difference occurred.",
        "band": "rejected",
        "lineage": "Tag clouds; Hearst et al., 2008",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "point-map",
    "title": "Point map",
    "question": "Where are the observations, and where do they gather?",
    "oneLine": "Exact coordinates at detail; counted clusters or density previews only when points collide.",
    "abstain": {
      "question": "Where were the photographs without GPS taken?",
      "why": "The Fujifilm and Ricoh records have no coordinate field. Assigning their folder date to the nearest phone location would turn temporal proximity into fabricated geography.",
      "instead": "A compact camera-by-year inventory that opens every non-GPS frame at recognition size.",
      "note": "Camera and capture date remain available. The renderer names the missing coordinate and does not place the frames on a map."
    },
    "members": [
      {
        "id": "exact-points",
        "name": "Exact point map",
        "when": "coordinates remain separable",
        "good": "One small mark per observation at its recorded coordinate. Points stay selectable and the quiet land layer supplies orientation.",
        "band": "1–2,000 visible points; ≥4 px hit target through an invisible halo",
        "lineage": "John Snow, 1854; Tufte, <em>Visual Explanations</em>, pp. 27–37",
        "status": "core"
      },
      {
        "id": "proportional-points",
        "name": "Proportional point symbols",
        "when": "a total belongs to a named location",
        "good": "Circle area carries count or total; the printed value prevents area judgment from doing all the work. Large symbols draw first so small centers remain reachable.",
        "band": "5–80 locations; roughly 4:1 radius range",
        "lineage": "Harness, 1838; Flannery, 1956",
        "status": "core"
      },
      {
        "id": "clusters",
        "name": "Counted clusters",
        "when": "points overlap at the current extent",
        "good": "Nearby points merge into a circle with an exact count. Opening it reveals all members; at a closer extent the cluster must resolve.",
        "band": "100–100,000 points; cluster radius and projection declared",
        "lineage": "hierarchical spatial clustering; Supercluster, 2016",
        "status": "core"
      },
      {
        "id": "dot-density",
        "name": "Dot-density preview",
        "when": "the overview asks where records concentrate",
        "good": "Every dot remains an observation, drawn with low opacity and a stated total. It is a record-density preview, never a population rate.",
        "band": "500–50,000 points at overview scale",
        "lineage": "Tufte's census dot map, <em>VDQI</em>, pp. 155–157",
        "status": "variant"
      },
      {
        "id": "point-multiples",
        "name": "Shared-extent point multiples",
        "when": "location repeats by period or group",
        "good": "The same projection, extent, and point size repeat across panels. The reader sees the points move, appear, or vanish without a changing frame.",
        "band": "2–12 panels; 20–2,000 points per panel",
        "lineage": "Tufte, small multiples, <em>Envisioning Information</em>, pp. 67–79",
        "status": "variant"
      },
      {
        "id": "pins",
        "name": "Map pins",
        "when": "never for analytical quantity",
        "good": "A large pictogram covers nearby observations, points at an ambiguous pixel, and encourages one-by-one browsing. Use small exact dots with direct labels for the few important places.",
        "band": "rejected",
        "lineage": "consumer map interface convention",
        "status": "rejected"
      },
      {
        "id": "jittered",
        "name": "Jittered location map",
        "when": "never without an uncertainty model",
        "good": "Moving a point to make it visible changes the location claim. Aggregate, disclose coarsening, or use an inset rather than fabricate coordinates.",
        "band": "rejected",
        "lineage": "collision-avoidance shortcut",
        "status": "rejected"
      },
      {
        "id": "heat-blob",
        "name": "Uncalibrated heat blob",
        "when": "never as the final answer",
        "good": "A smooth glow hides individual records and depends strongly on bandwidth. If density is needed, route to a calibrated field with samples and units visible.",
        "band": "rejected",
        "lineage": "default web-map heat layer",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "profile",
    "title": "Profile",
    "question": "How does each item differ across several independent measures?",
    "oneLine": "One row per item, one honest scale per measure, no composite score.",
    "abstain": {
      "question": "Which project is healthiest overall?",
      "why": "The files contain meetings, mail, commits, and dates, but no defensible weights that turn them into one health score.",
      "instead": "Show the measures in a profile table and keep the judgment with the reader.",
      "note": "The abstention lists each project and its separate measures, with no ranking."
    },
    "members": [
      {
        "id": "profile-table",
        "name": "Profile table",
        "when": "the default",
        "good": "Exact values stay in aligned columns; a tiny bar or dot gives each measure a visual cadence. Rows remain readable and sortable.",
        "band": "3-60 items, 2-8 measures",
        "lineage": "Statistical table; Tufte's patient-status display, 1994",
        "status": "core"
      },
      {
        "id": "dot-strips",
        "name": "Aligned dot strips",
        "when": "position matters more than exact lookup",
        "good": "Each measure gets a separate horizontal scale. Dots align by item across columns, with names repeated at the row.",
        "band": "3-30 items, 2-6 measures",
        "lineage": "Cleveland dot plots, 1985",
        "status": "core"
      },
      {
        "id": "small-multiples",
        "name": "Measure small multiples",
        "when": "each measure has a short history",
        "good": "One panel per measure, one line per named item, and direct end labels. Units never share an axis.",
        "band": "1-8 items, 2-8 measures",
        "lineage": "Tufte, multiples in space and time",
        "status": "core"
      },
      {
        "id": "reference-band",
        "name": "Reference-band profile",
        "when": "a valid normal range exists",
        "good": "Each value is placed against a declared reference interval. The band is source data, not a generic average.",
        "band": "1-30 items, 2-12 measures",
        "lineage": "Powsner and Tufte, patient status, 1994",
        "status": "core"
      },
      {
        "id": "parallel",
        "name": "Parallel coordinates",
        "when": "few items, several measures",
        "good": "A line connects independently scaled axes. Direct labels and highlighting are mandatory because crossings accumulate quickly.",
        "band": "2-12 items, 3-8 measures",
        "lineage": "Inselberg, 1985; Wegman, 1990",
        "status": "variant"
      },
      {
        "id": "glyph-row",
        "name": "Profile glyph row",
        "when": "the values already have familiar directions",
        "good": "A row of tiny signed bars can compare compact profiles, but each bar still needs its measure heading and scale.",
        "band": "6-80 items, 3-6 measures",
        "lineage": "Bertin's reorderable matrix; modern table glyphs",
        "status": "variant"
      },
      {
        "id": "radar",
        "name": "Radar chart or face glyph",
        "when": "never as a quantitative comparison",
        "good": "Axis order changes the shape, polygon area has no stable meaning, and faces invite categorical readings of continuous values.",
        "band": "rejected",
        "lineage": "Chernoff faces, 1973; radial profiles",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "rank",
    "title": "Rank",
    "question": "Which of these is largest, which smallest, and by how much?",
    "oneLine": "Named things sorted by one comparable measure, exact values at the marks.",
    "abstain": {
      "question": "Which of my projects deserves attention this week?",
      "why": "there is no measure. “Attention” is a judgment; any number put beside a project is a score someone invented, and sorting invented scores draws false precision as a bar. The earlier gallery's rank specimen did exactly this, ranking projects 92, 84, 77.",
      "instead": "The active projects with what is actually due, overdue, and waiting in each — a list with its evidence, which the reader sorts in their head.",
      "note": "No bar. The rows carry counts the reader can check, not a composite."
    },
    "members": [
      {
        "id": "bar-list",
        "name": "Sorted bar list",
        "when": "the default",
        "good": "Length from a shared zero is the perceptual task people do best (Cleveland &amp; McGill 1984). Labels on the left, exact values at the bar ends, no axis needed.",
        "band": "3–40 rows",
        "lineage": "Playfair, <em>Commercial and Political Atlas</em>, 1786",
        "status": "core"
      },
      {
        "id": "dot-plot",
        "name": "Dot plot",
        "when": "many rows, or a non-zero origin",
        "good": "A dot on a hairline carries position without ink; forty to a few hundred rows stay readable, and a scale that need not start at zero is honest here because nothing is measured by length.",
        "band": "20–300 rows",
        "lineage": "Cleveland, <em>Elements of Graphing Data</em>, 1985",
        "status": "core"
      },
      {
        "id": "slopegraph",
        "name": "Slopegraph",
        "when": "two states of the ranking",
        "good": "Names and values on both sides, a line between. Rises and falls read as slopes; the order on each side is the rank. Beats paired bars at every count.",
        "band": "5–40 items, 2–4 states",
        "lineage": "Tufte, <em>VDQI</em>, p. 158, 1983",
        "status": "core"
      },
      {
        "id": "ranked-table",
        "name": "Ranked table with sparklines",
        "when": "rank plus history",
        "good": "Tufte's supertable: words, numbers, and word-sized graphics in one aligned reading surface. The sort gives standing; each row's sparkline gives the path to it.",
        "band": "5–60 rows",
        "lineage": "Tufte, <em>Beautiful Evidence</em>, pp. 46–63, 2006",
        "status": "core"
      },
      {
        "id": "bump",
        "name": "Bump chart",
        "when": "rank across many states, order only",
        "good": "Position over several periods when only the order matters and magnitudes would clutter. Lines cross; labels at both ends.",
        "band": "≤12 items, 3–12 states",
        "lineage": "Sports league tables; Cox, NYT, 2000s",
        "status": "variant"
      },
      {
        "id": "dumbbell",
        "name": "Dumbbell",
        "when": "two values per item with a range between",
        "good": "Two dots joined by a line: before and after, low and high, mine and the group's. Sort by either end or by the gap.",
        "band": "5–40 rows",
        "lineage": "Cleveland; popularised by Schwabish",
        "status": "variant"
      },
      {
        "id": "pareto",
        "name": "Pareto",
        "when": "the question is how few account for how much",
        "good": "Sorted bars with a cumulative share line; reads ‘the top six merchants are 70% of spending.’ The line must share the bars' order.",
        "band": "8–60 rows",
        "lineage": "Pareto 1896; Juran 1950s",
        "status": "variant"
      },
      {
        "id": "isotype",
        "name": "Unit chart (Isotype)",
        "when": "the count is small and countable",
        "good": "Each symbol is one unit; rows of them are a bar that can be counted. Never scale a symbol's area to a quantity.",
        "band": "values ≤ 60 units",
        "lineage": "Neurath &amp; Arntz, 1930s",
        "status": "variant"
      },
      {
        "id": "pie",
        "name": "Pie chart",
        "when": "never for rank",
        "good": "Angle and area are the channels people judge worst; a sorted bar list carries the same data with exact values. “The only worse design than a pie chart is several of them.”",
        "band": "—",
        "lineage": "Tufte, <em>VDQI</em>, p. 178",
        "status": "rejected"
      },
      {
        "id": "word-cloud",
        "name": "Word cloud",
        "when": "never",
        "good": "Size of type is read as importance but cannot be compared; position means nothing; long words look bigger. A ranked table of the same phrases shows the counts.",
        "band": "—",
        "lineage": "Hearst et al., 2008 (why tag clouds fail)",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "region-map",
    "title": "Region map",
    "question": "How does a rate or category vary across bounded places?",
    "oneLine": "Bounded areas carrying normalized values, declared categories, or missingness.",
    "abstain": {
      "question": "Which country made me happiest?",
      "why": "A mood value attached to a few travel days is neither a stable country-level measure nor a causal claim. Shading nations would amplify sparse diary entries into geographic judgment.",
      "instead": "A dated passage list for every travel-day mood entry, grouped by trip and retaining missing days.",
      "note": "The atlas keeps the words, dates, and missingness visible. It does not manufacture a national score."
    },
    "members": [
      {
        "id": "choropleth",
        "name": "Rate choropleth",
        "when": "one normalized value per region",
        "good": "A light-to-dark ordered ramp carries a share or rate. The denominator, boundary vintage, and observed-region range are printed beside the map.",
        "band": "5–300 regions; 3–7 declared classes",
        "lineage": "Dupin, 1826; Tufte, <em>VDQI</em>, pp. 16–21",
        "status": "core"
      },
      {
        "id": "categorical",
        "name": "Categorical region map",
        "when": "the region's class is the finding",
        "good": "A small set of named categories may fill regions, but every observed region is also directly labelled. Hue identifies; it never pretends to order.",
        "band": "3–8 categories; 5–150 regions",
        "lineage": "Bertin, <em>Semiology of Graphics</em>, 1967",
        "status": "core"
      },
      {
        "id": "region-symbols",
        "name": "Region symbols",
        "when": "the value is a total",
        "good": "A circle centered on each observed region carries count by area while the region stays a quiet locator. This is the honest alternative to shading raw counts.",
        "band": "5–80 regions; symbol centers must remain separable",
        "lineage": "Harness, 1838; Flannery, 1956",
        "status": "core"
      },
      {
        "id": "map-series",
        "name": "Shared-scale map series",
        "when": "the same measure repeats by period",
        "good": "Projection, extent, ramp, and breakpoints stay fixed. Only the observations change, so geographic change can be seen without relearning the frame.",
        "band": "2–12 panels in one eyespan",
        "lineage": "Tufte's Los Angeles pollution multiples, <em>VDQI</em>, p. 42",
        "status": "variant"
      },
      {
        "id": "raw-count-fill",
        "name": "Raw-count choropleth",
        "when": "never across unequal regions",
        "good": "Land area receives visual weight unrelated to the count or population. Put totals in proportional symbols or calculate a rate with a real denominator.",
        "band": "rejected",
        "lineage": "Tufte's “blot map” critique, <em>VDQI</em>, p. 20",
        "status": "rejected"
      },
      {
        "id": "bivariate",
        "name": "Bivariate choropleth",
        "when": "not as a default",
        "good": "A 3×3 scheme already asks the reader to decode nine mixtures; a 4×4 scheme becomes a verbal lookup exercise. Prefer paired small maps with shared regions.",
        "band": "rejected here; 3×3 is an exceptional ceiling",
        "lineage": "Tufte, <em>VDQI</em>, pp. 153–154; Stevens",
        "status": "rejected"
      },
      {
        "id": "extruded",
        "name": "Extruded region map",
        "when": "never on a reading surface",
        "good": "Perspective hides regions and makes height, top area, and footprint compete for one value. A labelled map beside a ranked table is both denser and more exact.",
        "band": "rejected",
        "lineage": "computer-cartography default",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "relationship",
    "title": "Relationship",
    "question": "How do two measured quantities vary together?",
    "oneLine": "One item per point, two measured quantities, with marginals and evidence close by.",
    "abstain": {
      "question": "Did sleeping less make my running pace slower?",
      "why": "The files contain nightly sleep and workout pace, but they do not record training load, illness, weather, route difficulty, or whether the run followed that sleep. A fitted line would look causal without carrying the needed evidence.",
      "instead": "A dated table of runs beside recorded sleep, route, distance, and heart rate, with no causal claim.",
      "note": "The table keeps the paired observations and the missing explanation visible."
    },
    "members": [
      {
        "id": "scatter",
        "name": "Scatterplot",
        "when": "the default",
        "good": "Position on common scales carries both values. Direct labels identify the few points that merit attention.",
        "band": "10 to about 5,000 points",
        "lineage": "Herschel, paired observations, 1833",
        "status": "core"
      },
      {
        "id": "annotated",
        "name": "Annotated scatterplot",
        "when": "a few exceptions matter",
        "good": "The same plot, with names written beside selected points and every point still present.",
        "band": "10 to 500 points; up to 12 labels",
        "lineage": "Tufte, words on graphics, <em>VDQI</em>, p. 181",
        "status": "core"
      },
      {
        "id": "marginals",
        "name": "Dot-dash plot",
        "when": "joint and marginal shape both matter",
        "good": "Ticks along the two range frames show each one-dimensional distribution without a second figure.",
        "band": "10 to 2,000 points",
        "lineage": "Tufte, <em>VDQI</em>, p. 133",
        "status": "core"
      },
      {
        "id": "connected",
        "name": "Connected scatterplot",
        "when": "one path has a meaningful order",
        "good": "A thin path joins dated points. Start, finish, and turns are labelled so time is not hidden.",
        "band": "4 to 40 points, no more than 3 paths",
        "lineage": "Du Bois and later statistical atlases",
        "status": "variant"
      },
      {
        "id": "sized",
        "name": "Sized-point scatterplot",
        "when": "one secondary quantity is essential",
        "good": "Area carries a coarse third quantity; the exact value appears on selection because area is judged poorly.",
        "band": "10 to 200 points",
        "lineage": "statistical bubble plots",
        "status": "variant"
      },
      {
        "id": "binned",
        "name": "Binned relationship",
        "when": "points overprint",
        "good": "Fixed rectangular bins count observations. The evidence drawer keeps every row in a selected bin.",
        "band": "5,000 to 10 million points",
        "lineage": "Carr et al., hexagon binning, 1987",
        "status": "variant"
      },
      {
        "id": "dual-axis",
        "name": "Dual-axis correlation",
        "when": "never",
        "good": "Two independent scales can be tuned to make unrelated series appear to agree.",
        "band": "rejected",
        "lineage": "spreadsheet default",
        "status": "rejected"
      },
      {
        "id": "scatter-3d",
        "name": "3-D scatterplot",
        "when": "never on a reading page",
        "good": "Perspective hides points and changes positions as the view turns.",
        "band": "rejected",
        "lineage": "desktop charting",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "sequence",
    "title": "Sequence",
    "question": "In what order did the steps, states, or frames occur?",
    "oneLine": "Ordered records laid out step by step, without inventing elapsed time.",
    "abstain": {
      "question": "What is the order of spending categories in my bank export?",
      "why": "Categories have totals but no inherent predecessor or successor. Sorting by amount would create rank, not sequence.",
      "instead": "Use a ranked part-to-whole table and keep transactions in their actual date order as evidence.",
      "note": "The abstention renders the categories as an unsorted table with counts and totals."
    },
    "members": [
      {
        "id": "step-strip",
        "name": "Step strip",
        "when": "states are categorical",
        "good": "Equal step spacing makes succession explicit. Repeated states keep their labels instead of merging into one block.",
        "band": "3-80 steps",
        "lineage": "Instruction diagrams and musical notation",
        "status": "core"
      },
      {
        "id": "connected-series",
        "name": "Connected sequence",
        "when": "each step has one measured value",
        "good": "Position shows the value and the connecting line shows order. The horizontal axis says step, not time.",
        "band": "3-500 steps",
        "lineage": "Marey's graphical method",
        "status": "core"
      },
      {
        "id": "run-chart",
        "name": "Run chart",
        "when": "the sequence has a meaningful reference",
        "good": "A connected series plus one labelled reference line reveals runs above, below, rising, or falling.",
        "band": "8-500 steps",
        "lineage": "Statistical process control",
        "status": "core"
      },
      {
        "id": "storyboard",
        "name": "Storyboard",
        "when": "recognition depends on frames",
        "good": "Frames sit in order with step or timestamp and a short action label. Text stays beside the image it explains.",
        "band": "3-24 frames",
        "lineage": "Muybridge and Marey; film storyboards",
        "status": "core"
      },
      {
        "id": "state-ribbon",
        "name": "State ribbon",
        "when": "durations are known",
        "good": "Segment width carries elapsed time and the state name sits inside or directly above it. A thin axis supplies scale.",
        "band": "3-60 states",
        "lineage": "Gantt and machine-state traces",
        "status": "variant"
      },
      {
        "id": "time-position",
        "name": "Time-position diagram",
        "when": "a path has measured position and time",
        "good": "Slope encodes speed, stops become horizontal segments, and crossings preserve when and where paths meet.",
        "band": "2-40 paths, 10-500 observations each",
        "lineage": "Marey and Ibry train schedule, 1885",
        "status": "variant"
      },
      {
        "id": "animation",
        "name": "Animation or Sankey",
        "when": "never as a sequence substitute",
        "good": "Animation hides prior frames in memory; Sankey width answers quantity flow, not exact step order. Use adjacent steps or the flow family.",
        "band": "rejected",
        "lineage": "Tversky et al., 2002; Sankey, 1898",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "timeline",
    "title": "Timeline",
    "question": "What happened when, for how long, and alongside what else?",
    "oneLine": "Events and intervals placed at their actual dates, with overlaps left visible.",
    "abstain": {
      "question": "When were these library works created when only publication year is known?",
      "why": "A year is an interval of uncertainty, not a date. Day-level placement would claim precision the record lacks.",
      "instead": "Use a table by publication year or an interval band spanning the known year.",
      "note": "The abstention shows title, author, year, and source path in a table."
    },
    "members": [
      {
        "id": "event-strip",
        "name": "Event strip",
        "when": "events are brief and one-dimensional",
        "good": "Ticks at exact dates reveal bursts and gaps. Only selected or exceptional events receive labels.",
        "band": "5-500 events",
        "lineage": "Chronologies and rug plots",
        "status": "core"
      },
      {
        "id": "interval",
        "name": "Interval timeline",
        "when": "start and end both matter",
        "good": "A horizontal segment represents duration on a zero-distortion time scale. Names sit beside the segment.",
        "band": "3-60 intervals",
        "lineage": "Priestley, <em>Chart of Biography</em>, 1765",
        "status": "core"
      },
      {
        "id": "swimlane",
        "name": "Swimlane timeline",
        "when": "events belong to stable categories",
        "good": "Parallel lanes reveal concurrency without merging categories. The lane name is a direct label.",
        "band": "2-12 lanes, up to 500 events",
        "lineage": "Project schedules and medical records",
        "status": "core"
      },
      {
        "id": "chronicle",
        "name": "Annotated chronicle",
        "when": "a few documented events need explanation",
        "good": "Short notes sit at their dates and point to the record. Annotation adds fact, not decoration.",
        "band": "5-30 events",
        "lineage": "Historical chronologies; Tufte's integrated annotation",
        "status": "core"
      },
      {
        "id": "calendar",
        "name": "Calendar timeline",
        "when": "weekday and week rhythms matter",
        "good": "Civil time is explicit: days by weeks, months labelled, missing dates empty. Colour carries magnitude only after the date cell is located.",
        "band": "3 months-3 years",
        "lineage": "Calendar heat maps",
        "status": "variant"
      },
      {
        "id": "revision",
        "name": "Revision bands",
        "when": "versions have dated survival",
        "good": "Bands show when material enters, persists, and disappears across revisions. Selection opens the actual version records.",
        "band": "5-100 versions",
        "lineage": "History Flow, 2004",
        "status": "variant"
      },
      {
        "id": "spiral",
        "name": "Spiral timeline",
        "when": "never for exact comparison",
        "good": "Radius, angle, and arc length compete, labels rotate, and later dates receive more space. Use a line or calendar.",
        "band": "rejected",
        "lineage": "Decorative chronologies",
        "status": "rejected"
      }
    ]
  },
  {
    "id": "trend",
    "title": "Trend",
    "question": "How did a measured quantity change through time?",
    "oneLine": "Values on a continuous time axis, with raw records behind every aggregate.",
    "abstain": {
      "question": "Is my library reading trend improving when many books have no read date?",
      "why": "A missing read date is not an unread event at a known time. Plotting those records at zero would invent observations.",
      "instead": "List books with known read dates separately from books whose status or date is missing.",
      "note": "The abstention renders a dated table and an explicit missing-date count."
    },
    "members": [
      {
        "id": "line",
        "name": "Time-series line",
        "when": "the default for repeated measures",
        "good": "A thin line on proportional time shows direction and local variation. Direct end labels name every series.",
        "band": "12-5,000 observations, 1-4 series",
        "lineage": "Playfair, 1786",
        "status": "core"
      },
      {
        "id": "period-bars",
        "name": "Period bars",
        "when": "each value is a discrete total",
        "good": "Monthly commits or annual spending start at zero because bar length carries magnitude. Gaps remain empty.",
        "band": "6-60 periods",
        "lineage": "Playfair; statistical annuals",
        "status": "core"
      },
      {
        "id": "irregular-dots",
        "name": "Irregular observation plot",
        "when": "sampling intervals vary",
        "good": "Dots preserve exact observation times without implying values between them. A line is optional and usually omitted.",
        "band": "5-2,000 observations",
        "lineage": "Scientific observation plots",
        "status": "core"
      },
      {
        "id": "spark-table",
        "name": "Sparkline table",
        "when": "many named series",
        "good": "One word-sized history per row keeps rank, latest value, and trend together. All rows share their measure's scale.",
        "band": "5-100 series, 12-200 periods",
        "lineage": "Tufte, <em>Beautiful Evidence</em>, pp. 46-63",
        "status": "core"
      },
      {
        "id": "small-multiples",
        "name": "Trend small multiples",
        "when": "series would cross or units differ",
        "good": "Repeated panels keep a common time axis and, within a unit, a common vertical scale.",
        "band": "2-24 panels",
        "lineage": "Tufte, small multiples",
        "status": "variant"
      },
      {
        "id": "horizon",
        "name": "Horizon strip",
        "when": "vertical space is scarce and readers know the fold",
        "good": "Layered bands compact many comparable series, but exact reading requires a nearby value and a documented baseline.",
        "band": "20-200 series",
        "lineage": "Saito et al., 2005",
        "status": "variant"
      },
      {
        "id": "streamgraph",
        "name": "Streamgraph",
        "when": "not for ordinary trend",
        "good": "A moving baseline impairs value reading and changing thickness mixes composition with trend. Use only for a bounded composition question.",
        "band": "rejected for trend",
        "lineage": "Byron and Wattenberg, 2008",
        "status": "rejected"
      }
    ]
  }
]);

export default AUTHORED_FAMILY_ATLAS_CONTENT;
