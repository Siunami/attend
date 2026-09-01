import { formLabel, htmlElement, number, records, selectable, selectedClass, text } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "collection-atlas", memberId: "contact-atlas", fixtureId: "collection-atlas/contact-atlas/fixture-v1" });

const ASSET_ROUTE = /^(?:\.\/)?assets\/(asset_[a-f0-9]{32})$/u;

function safeAssetRoute(value, assetId) {
  const match = typeof value === "string" ? ASSET_ROUTE.exec(value) : null;
  if (!match || match[1] !== assetId) return null;
  return `./assets/${assetId}`;
}

function announcePage(region) {
  if (typeof region.dispatchEvent !== "function" || typeof globalThis.CustomEvent !== "function") return;
  region.dispatchEvent(new CustomEvent("attend-form-page", { bubbles: true }));
}

function disclosureSummary(payload) {
  const disclosure = payload?.captureTimeDisclosure;
  if (!disclosure || typeof disclosure !== "object" || Array.isArray(disclosure)) return null;
  const basis = text(disclosure.basis).trim();
  const timezoneStatement = text(disclosure.timezoneStatement).trim();
  const tieStatement = text(disclosure.tieStatement).trim();
  const tieBreak = text(disclosure.tieBreak).trim();
  if (!basis || !timezoneStatement || !tieStatement || !tieBreak) return null;
  return `Order: ${basis}. ${timezoneStatement} ${tieStatement} Tie break: ${tieBreak}.`;
}

function renderPage(region, dataset, selection, items, page, pageSize, announce = true) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const boundedPage = Math.max(0, Math.min(page, pageCount - 1));
  const start = boundedPage * pageSize;
  const visible = items.slice(start, start + pageSize);
  const status = htmlElement("p", "contact-atlas__status", `Showing ${start + 1}–${start + visible.length} of ${items.length} images`);
  status.setAttribute("aria-live", "polite");
  const summary = htmlElement("header", "contact-atlas__summary");
  summary.append(status);
  const disclosure = disclosureSummary(dataset.payload);
  if (disclosure) summary.append(htmlElement("p", "contact-atlas__disclosure", disclosure));
  const grid = htmlElement("ol", "contact-atlas__grid");
  visible.forEach((item) => {
    const route = safeAssetRoute(item.previewRoute ?? item.preview?.route, item.assetId);
    const li = htmlElement("li", "contact-atlas__item");
    const button = htmlElement("button", selectedClass(item, selection, "contact-atlas__button"));
    button.type = "button";
    for (const [key, value] of Object.entries(selectable(item))) button.setAttribute(key, value);
    button.setAttribute("aria-label", `${formLabel(item)}, captured ${text(item.captureTime, "at an unknown time")}`);
    const frame = htmlElement("span", "contact-atlas__frame");
    const unavailable = htmlElement("span", "contact-atlas__unavailable", "Preview unavailable");
    unavailable.setAttribute("aria-hidden", "true");
    const image = htmlElement("img", "contact-atlas__image");
    image.src = route;
    image.alt = "";
    image.loading = "eager";
    image.decoding = "async";
    image.setAttribute("width", String(Math.max(96, number(item.previewWidth ?? item.width, 144))));
    image.setAttribute("height", String(Math.max(96, number(item.previewHeight ?? item.height, 96))));
    image.addEventListener("load", () => frame.setAttribute("data-preview-state", "available"));
    image.addEventListener("error", () => {
      image.hidden = true;
      frame.setAttribute("data-preview-state", "unavailable");
    });
    frame.append(unavailable, image);
    button.append(frame, htmlElement("span", "contact-atlas__label", formLabel(item)), htmlElement("time", "contact-atlas__time", text(item.captureTime)));
    li.append(button);
    grid.append(li);
  });
  const navigation = htmlElement("nav", "contact-atlas__pagination");
  navigation.setAttribute("aria-label", "Contact atlas pages");
  const previous = htmlElement("button", null, "Previous");
  previous.type = "button";
  previous.disabled = boundedPage === 0;
  const next = htmlElement("button", null, "Next");
  next.type = "button";
  next.disabled = boundedPage >= pageCount - 1;
  previous.addEventListener("click", () => renderPage(region, dataset, selection, items, boundedPage - 1, pageSize));
  next.addEventListener("click", () => renderPage(region, dataset, selection, items, boundedPage + 1, pageSize));
  navigation.append(previous, htmlElement("span", null, `Page ${boundedPage + 1} of ${pageCount}`), next);
  region.replaceChildren(summary, grid, navigation);
  if (announce) announcePage(region);
}

export default function renderContactAtlas(root, dataset, selection) {
  const items = records(dataset, "items");
  const invalid = items.find((item) => !safeAssetRoute(item.previewRoute ?? item.preview?.route, item.assetId));
  if (invalid) throw new Error("Contact atlas assets must use their owning session's opaque relative asset route.");
  const region = htmlElement("section", "contact-atlas");
  region.setAttribute("data-form-id", `${dataset.familyId}/${dataset.memberId}`);
  region.setAttribute("aria-label", dataset.title);
  root.replaceChildren(region);
  renderPage(region, dataset, selection, items, 0, Math.min(8, Math.max(1, number(dataset.payload?.pageSize, 8))), false);
}
