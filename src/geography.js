export const US_STATES_GEOGRAPHY = Object.freeze({
  id: "us-atlas/states-10m",
  version: "3.0.1",
  object: "states",
  identifierScheme: "US Census two-digit state or territory FIPS",
});

export const US_STATE_FIPS_IDS = Object.freeze([
  "01", "02", "04", "05", "06", "08", "09", "10", "11", "12",
  "13", "15", "16", "17", "18", "19", "20", "21", "22", "23",
  "24", "25", "26", "27", "28", "29", "30", "31", "32", "33",
  "34", "35", "36", "37", "38", "39", "40", "41", "42", "44",
  "45", "46", "47", "48", "49", "50", "51", "53", "54", "55",
  "56", "60", "66", "69", "72", "78",
]);

const US_STATE_FIPS = new Set(US_STATE_FIPS_IDS);

export function canonicalUsStateFips(value) {
  let candidate;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 99) {
    candidate = String(value).padStart(2, "0");
  } else if (typeof value === "string" && /^\d{1,2}$/u.test(value.trim())) {
    candidate = value.trim().padStart(2, "0");
  } else {
    return null;
  }
  return US_STATE_FIPS.has(candidate) ? candidate : null;
}
