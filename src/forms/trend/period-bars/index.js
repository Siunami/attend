import {
  projectFormPayload,
  requireExecutableForm,
  resolveVisualTarget,
} from "../../index.js";
import { formFixture } from "../../fixtures.js";

export const descriptor = requireExecutableForm("trend", "period-bars");
export const fixture = formFixture(descriptor);
export const projector = (observations) => projectFormPayload(descriptor, observations);
export const targetResolver = (targetId, observations, payload) =>
  resolveVisualTarget(descriptor, targetId, observations, payload);
