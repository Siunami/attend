import { legacyForm } from "../legacy.js";
export const descriptor = Object.freeze({ familyId: "region-map", memberId: "choropleth", fixtureId: "region-map/choropleth/fixture-v1", incumbent: true, assets: ["vendor/d3.min.js", "vendor/topojson-client.min.js", "vendor/us-states.json", "vendor/us-counties.json"] });
export default legacyForm(descriptor);
