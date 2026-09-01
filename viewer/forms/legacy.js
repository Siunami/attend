export function legacyForm(descriptor) {
  return async function renderIncumbent(root, dataset, selection, context = {}) {
    if (typeof context.renderLegacy !== "function") {
      throw new Error(`No incumbent implementation is bound for ${descriptor.familyId}/${descriptor.memberId}`);
    }
    const selected = selection.selectedIds.length > 0 ? selection.selectedIds : null;
    await context.renderLegacy(root, dataset, selected, { selectedNodeId: context.selectedNodeId });
  };
}

