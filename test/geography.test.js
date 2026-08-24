import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  US_STATE_FIPS_IDS,
  canonicalUsStateFips,
} from "../src/geography.js";

test("the fixed region-map id set matches the bundled us-atlas geometry", async () => {
  const topology = JSON.parse(await readFile(
    new URL("../viewer/vendor/us-states.json", import.meta.url),
    "utf8",
  ));
  const geometryIds = topology.objects.states.geometries
    .map((geometry) => String(geometry.id).padStart(2, "0"))
    .sort();
  assert.deepEqual([...US_STATE_FIPS_IDS].sort(), geometryIds);
  assert.equal(canonicalUsStateFips(6), "06");
  assert.equal(canonicalUsStateFips("06"), "06");
  assert.equal(canonicalUsStateFips("TZ-01"), null);
});
