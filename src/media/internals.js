const PRIVATE_IMAGE_ASSETS = Symbol("attend.private-image-assets");

export function attachPrivateImageAssets(imageSet, value) {
  Object.defineProperty(imageSet, PRIVATE_IMAGE_ASSETS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value,
  });
  return imageSet;
}

export function privateImageAssets(imageSet) {
  return imageSet?.[PRIVATE_IMAGE_ASSETS] ?? null;
}
