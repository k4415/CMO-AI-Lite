import { resolveContextAction } from "./resolve-context.js";
import { extractFactsAction } from "./extract-facts.js";
import { createWhoWhatAction } from "./create-who-what.js";
import { createBannerBriefAction } from "./create-banner-brief.js";

export const actions = [
  resolveContextAction,
  extractFactsAction,
  createWhoWhatAction,
  createBannerBriefAction
];

const promptModuleByAction = {
  "research.extract_facts": "lite.product-research.v1",
  "strategy.create_who_what": "lite.strategy-who-what.v1",
  "content.banner_create": "lite.banner-creator.v1"
};

export function listActions() {
  return actions.map(({ id, skillId, phase, name, description, reads, writes, requiresReview }) => ({
    id,
    skillId,
    promptModuleId: promptModuleByAction[id] || null,
    phase,
    name,
    description,
    reads,
    writes,
    requiresReview
  }));
}

export function getAction(actionId) {
  return actions.find((action) => action.id === actionId);
}
