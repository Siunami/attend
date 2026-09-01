import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { catalogReceiptForMember } from "../src/catalog/index.js";
import {
  buildEvidencePacket,
  buildImageEvidenceStore,
  validateEvidenceStore,
} from "../src/evidence.js";
import {
  compileMapWithEvidence,
  validateNormalizedSourceBundle,
} from "../src/pipeline/compile.js";
import {
  LOCAL_IMAGE_SET_LIMITS,
  loadLocalImageSet,
  sessionAssetPaths,
  stageLocalImageSet,
} from "../src/media/index.js";
import { createViewerServer } from "../src/server.js";
import { createSession, loadSession } from "../src/session-store.js";

function littleEntry(tag, type, count, value) {
  const entry = Buffer.alloc(12);
  entry.writeUInt16LE(tag, 0);
  entry.writeUInt16LE(type, 2);
  entry.writeUInt32LE(count, 4);
  if (type === 3 && count === 1) entry.writeUInt16LE(value, 8);
  else entry.writeUInt32LE(value, 8);
  return entry;
}

function exifPayload({
  timestamp = "2024:01:02 03:04:05",
  width = 160,
  height = 120,
  orientation = 1,
  includeTimestamp = true,
} = {}) {
  const ifd0Entries = [
    littleEntry(0x0100, 4, 1, width),
    littleEntry(0x0101, 4, 1, height),
    littleEntry(0x0112, 3, 1, orientation),
    littleEntry(0x8769, 4, 1, 62),
  ];
  const exifEntries = [
    ...(includeTimestamp ? [littleEntry(0x9003, 2, 20, 104)] : []),
    littleEntry(0xa002, 4, 1, width),
    littleEntry(0xa003, 4, 1, height),
  ];
  const exifIfdOffset = 62;
  const dateOffset = exifIfdOffset + 2 + exifEntries.length * 12 + 4;
  if (includeTimestamp) exifEntries[0].writeUInt32LE(dateOffset, 8);
  const tiff = Buffer.alloc(dateOffset + (includeTimestamp ? 20 : 0));
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(ifd0Entries.length, 8);
  ifd0Entries.forEach((entry, index) => entry.copy(tiff, 10 + index * 12));
  tiff.writeUInt32LE(0, 10 + ifd0Entries.length * 12);
  tiff.writeUInt16LE(exifEntries.length, exifIfdOffset);
  exifEntries.forEach((entry, index) => entry.copy(tiff, exifIfdOffset + 2 + index * 12));
  tiff.writeUInt32LE(0, exifIfdOffset + 2 + exifEntries.length * 12);
  if (includeTimestamp) tiff.write(`${timestamp}\0`, dateOffset, "ascii");
  return Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
}

function segment(marker, payload) {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpeg(options = {}) {
  const width = options.width ?? 160;
  const height = options.height ?? 120;
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  for (let index = 0; index < 3; index += 1) {
    sof[6 + index * 3] = index + 1;
    sof[7 + index * 3] = 0x11;
    sof[8 + index * 3] = 0;
  }
  const sos = Buffer.from([3, 1, 0, 2, 0, 3, 0, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, exifPayload({ ...options, width, height })),
    segment(0xc0, sof),
    segment(0xda, sos),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

async function imageFixture(t, { count = 12, optionsFor = () => ({}) } = {}) {
  const root = await mkdtemp(join(tmpdir(), "attend-image-set-"));
  const directory = join(root, "authorized photos");
  await mkdir(directory);
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(directory, `camera-${String(index + 1).padStart(2, "0")}.jpg`),
      jpeg(optionsFor(index)),
    );
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, relativeDirectory: "authorized photos" };
}

function phraseDataPackage(id = "data_0123456789abcdef") {
  return {
    schemaVersion: 1,
    kind: "attend-data-package",
    id,
    question: { text: "Which phrases recur?", target: "fixture" },
    hashes: { corpus: "a".repeat(64), config: "b".repeat(64), data: "c".repeat(64) },
    config: {
      minWords: 2,
      maxWords: 3,
      minCount: 2,
      minSources: 1,
      limit: 50,
      maxFileBytes: 100_000,
      ranking: [
        { field: "distinctSourceCount", direction: "desc" },
        { field: "occurrenceCount", direction: "desc" },
        { field: "phrase", direction: "asc" },
      ],
    },
    sources: [{
      id: "source_alpha",
      displayPath: "fixture.md",
      sha256: "d".repeat(64),
      kind: "text",
      byteLength: 20,
    }],
    rows: [{
      id: "phrase_fixture",
      phrase: "fixture phrase",
      wordCount: 2,
      occurrenceCount: 2,
      distinctSourceCount: 1,
      occurrences: [{ sourceId: "source_alpha", line: 1, excerpt: "fixture phrase" }],
    }],
    map: { id: "phrase-list", version: 1, labelField: "phrase", valueField: "occurrenceCount" },
    transformations: [],
    knownOmissions: [],
  };
}

test("local-image-set-v1 emits a compiler-valid, path-free, capture-ordered bundle", async (t) => {
  const fixture = await imageFixture(t, {
    optionsFor: (index) => ({
      timestamp: index < 2
        ? "2024:01:02 03:04:05"
        : `2024:01:${String(index + 1).padStart(2, "0")} 03:04:05`,
    }),
  });
  const loaded = await loadLocalImageSet({
    root: fixture.root,
    directory: fixture.relativeDirectory,
  });

  assert.equal(validateNormalizedSourceBundle(loaded.canonicalSourceBundle), loaded.canonicalSourceBundle);
  assert.equal(loaded.items.length, 12);
  assert.equal(loaded.paging.pageSize, 8);
  assert.equal(loaded.disclosures.timezone, "unknown");
  assert.equal(loaded.disclosures.timestampTies[0].count, 2);
  assert.deepEqual(loaded.items.map((item) => item.order), [...Array(12).keys()]);
  assert.ok(loaded.evidenceReferences.every((reference) => /^evidence_[a-f0-9]{16}$/u.test(reference.id)));
  assert.ok(loaded.canonicalSourceBundle.sources.every((source) =>
    /^images\/source_[a-f0-9]{32}\.jpg$/u.test(source.displayPath)));
  assert.ok(loaded.canonicalSourceBundle.records.every((record) =>
    record.evidenceRefs[0].locator.kind === "whole-file" &&
    record.media.preview.src === record.fields.previewRoute));
  const serialized = JSON.stringify(loaded);
  assert.doesNotMatch(serialized, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(serialized, /authorized photos/u);
  assert.equal(loaded.stagingManifest.assets.length, 12);
});

test("contact-atlas compiles whole-file evidence and bounded locator-only chat context", async (t) => {
  const fixture = await imageFixture(t);
  const loaded = await loadLocalImageSet({ root: fixture.root, directory: fixture.relativeDirectory });
  const compiled = await compileMapWithEvidence({
    familyId: "collection-atlas",
    catalog: catalogReceiptForMember("collection-atlas", "contact-atlas"),
    question: {
      text: "How did this photo collection unfold?",
      target: "authorized image set",
      analyticJob: "collection-atlas:contact-atlas",
    },
    sourceBundle: loaded.canonicalSourceBundle,
    roleMapping: {
      assetId: "fields.assetId",
      previewRoute: "fields.previewRoute",
      label: "fields.label",
      captureTime: "fields.captureTime",
      width: "fields.width",
      height: "fields.height",
      orientation: "fields.orientation",
      order: "fields.order",
    },
    options: { availableWidth: 1_200, mediaType: "image" },
  });
  assert.deepEqual(
    compiled.evidenceReferences.map((reference) => reference.id).sort(),
    loaded.evidenceReferences.map((reference) => reference.id).sort(),
  );
  const evidenceStore = buildImageEvidenceStore({
    dataPackage: compiled.dataPackage,
    sources: loaded.canonicalSourceBundle.sources,
    evidenceReferences: compiled.evidenceReferences,
    sourceBundleSha256: loaded.stagingManifest.sourceBundleSha256,
  });
  assert.equal(
    validateEvidenceStore({ dataPackage: compiled.dataPackage, evidenceStore }),
    evidenceStore,
  );
  const packet = buildEvidencePacket({
    dataPackage: compiled.dataPackage,
    evidenceStore,
    selection: { selectedMarkIds: [compiled.dataPackage.marks[0].id] },
  });
  assert.equal(packet.coverage.complete, false);
  assert.equal(packet.coverage.omittedBinarySourceCount, 1);
  assert.equal(packet.coverage.sampling, "whole-file-locator/v1");
  assert.match(packet.coverage.binaryEvidence, /locators only/u);
  assert.equal(packet.sources[0].media.contentIncluded, false);
  assert.equal(packet.sources[0].segments.length, 0);
});

test("image authorization abstains on traversal, symlinks, spoofing, malformed EXIF, and limits", async (t) => {
  const traversal = await imageFixture(t);
  await assert.rejects(
    loadLocalImageSet({ root: traversal.root, directory: "authorized photos/../authorized photos" }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "one-explicit-directory",
  );

  const linked = await imageFixture(t);
  const outside = join(linked.root, "outside.jpg");
  await writeFile(outside, jpeg());
  await symlink(outside, join(linked.directory, "linked.jpg"));
  await assert.rejects(
    loadLocalImageSet({ root: linked.root, directory: linked.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "no-symbolic-links",
  );

  const spoofed = await imageFixture(t);
  await writeFile(join(spoofed.directory, "spoof.jpg"), "not a jpeg");
  await assert.rejects(
    loadLocalImageSet({ root: spoofed.root, directory: spoofed.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "jpeg-signature",
  );

  const malformed = await imageFixture(t);
  await writeFile(join(malformed.directory, "camera-01.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe1]));
  await assert.rejects(
    loadLocalImageSet({ root: malformed.root, directory: malformed.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "well-formed-jpeg",
  );

  const tooLarge = await imageFixture(t);
  await writeFile(
    join(tooLarge.directory, "camera-01.jpg"),
    Buffer.alloc(LOCAL_IMAGE_SET_LIMITS.maxFileBytes + 1, 0xff),
  );
  await assert.rejects(
    loadLocalImageSet({ root: tooLarge.root, directory: tooLarge.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "file-size",
  );

  const totalTooLarge = await imageFixture(t, { count: 22 });
  for (let index = 0; index < 22; index += 1) {
    await truncate(
      join(totalTooLarge.directory, `camera-${String(index + 1).padStart(2, "0")}.jpg`),
      LOCAL_IMAGE_SET_LIMITS.maxFileBytes,
    );
  }
  await assert.rejects(
    loadLocalImageSet({ root: totalTooLarge.root, directory: totalTooLarge.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "total-size",
  );

  const missingTime = await imageFixture(t, {
    optionsFor: (index) => ({ includeTimestamp: index !== 0 }),
  });
  await assert.rejects(
    loadLocalImageSet({ root: missingTime.root, directory: missingTime.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "capture-time",
  );

  const oversized = await imageFixture(t, {
    optionsFor: (index) => index === 0 ? { width: 5_000, height: 4_000 } : {},
  });
  await assert.rejects(
    loadLocalImageSet({ root: oversized.root, directory: oversized.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "pixel-count",
  );

  const tooFew = await imageFixture(t, { count: 11 });
  await assert.rejects(
    loadLocalImageSet({ root: tooFew.root, directory: tooFew.relativeDirectory }),
    (error) => error.code === "IMAGE_SET_INELIGIBLE" && error.requirement === "image-count",
  );
});

test("staging fails closed when an authorized source changes", async (t) => {
  const fixture = await imageFixture(t);
  const loaded = await loadLocalImageSet({ root: fixture.root, directory: fixture.relativeDirectory });
  await writeFile(join(fixture.directory, "camera-01.jpg"), jpeg({ timestamp: "2025:02:03 04:05:06" }));
  await assert.rejects(
    stageLocalImageSet({
      root: fixture.root,
      sessionId: "session_changed_image",
      imageSet: loaded,
      dataPackage: phraseDataPackage(),
    }),
    (error) => ["IMAGE_SET_INELIGIBLE", "ASSET_CHANGED"].includes(error.code),
  );
});

test("session image routes serve only manifest-bound originals", async (t) => {
  const fixture = await imageFixture(t);
  const loaded = await loadLocalImageSet({ root: fixture.root, directory: fixture.relativeDirectory });
  const dataPackage = phraseDataPackage();
  const sessionId = "session_image_assets";
  const { assetReceipt } = await stageLocalImageSet({
    root: fixture.root,
    sessionId,
    imageSet: loaded,
    dataPackage,
  });
  const created = await createSession({
    root: fixture.root,
    id: sessionId,
    dataPackage,
    assetReceipt,
  });
  assert.deepEqual((await loadSession({ root: fixture.root, sessionId })).assetReceipt, assetReceipt);
  assert.deepEqual(created.assetReceipt, assetReceipt);
  await createSession({
    root: fixture.root,
    id: "session_without_assets",
    dataPackage: phraseDataPackage("data_fedcba9876543210"),
  });

  const assetsDir = join(fixture.root, "viewer");
  await mkdir(assetsDir);
  await Promise.all([
    writeFile(join(assetsDir, "index.html"), "<!doctype html><title>fixture</title>"),
    writeFile(join(assetsDir, "app.js"), ""),
    writeFile(join(assetsDir, "styles.css"), ""),
  ]);
  const viewer = await createViewerServer({
    root: fixture.root,
    analysisId: sessionId,
    assetsDir,
    token: "image-asset-test-token",
    instanceId: "image-asset-test-instance",
  });
  t.after(() => viewer.close());

  const item = loaded.items[0];
  const response = await fetch(new URL(item.previewRoute, viewer.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(
    Buffer.from(await response.arrayBuffer()).toString("hex"),
    (await readFile(join(fixture.directory, "camera-01.jpg"))).toString("hex"),
  );
  const crossSessionUrl = new URL(
    `../session_without_assets/assets/${item.assetId}`,
    viewer.url,
  );
  assert.equal((await fetch(crossSessionUrl)).status, 404);
  assert.equal(
    (await fetch(new URL("assets/asset_00000000000000000000000000000000", viewer.url))).status,
    404,
  );

  const stagedPath = join(
    fixture.root,
    sessionAssetPaths.directory,
    sessionId,
    `${item.assetId}.jpg`,
  );
  await writeFile(stagedPath, jpeg({ timestamp: "2026:03:04 05:06:07" }));
  assert.equal((await fetch(new URL(item.previewRoute, viewer.url))).status, 404);
});
