import { appendRunLog, saveRun } from "./project-store.js";
import { resolveContext } from "./context-resolver.js";
import { getAction } from "../actions/registry.js";

export async function runAction({ actionId, projectRoot, dryRun = false, force = false, input = {} }) {
  const action = getAction(actionId);
  if (!action) {
    return { ok: false, actionId, errorCode: "UNKNOWN_ACTION", message: "\u672a\u77e5\u306eAction\u3067\u3059: " + actionId };
  }

  const runId = createRunId(actionId);
  const context = await resolveContext(projectRoot);
  if (!context.ok) {
    return {
      ok: false,
      actionId,
      runId,
      errorCode: "INVALID_PROJECT",
      message: "\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u69cb\u9020\u304c\u4e0d\u5b8c\u5168\u3067\u3059\u3002",
      validation: context.validation,
      warnings: context.warnings
    };
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await action.handler({ projectRoot, context, runId, dryRun, force, input });
    const finishedAt = new Date().toISOString();
    const run = {
      ok: true,
      actionId,
      skillId: action.skillId || null,
      runId,
      status: result.status || "needs_review",
      startedAt,
      finishedAt,
      dryRun,
      readFiles: action.reads,
      writtenFiles: dryRun ? [] : result.writtenFiles || [],
      warnings: [...(context.warnings || []), ...(result.warnings || [])],
      nextActions: result.nextActions || []
    };

    if (!dryRun) {
      await saveRun(projectRoot, run);
      await appendRunLog(projectRoot, actionId + " \u3092\u5b9f\u884c\u3057\u307e\u3057\u305f\u3002status=" + run.status + " runId=" + runId);
    }

    return { ...run, data: result.data || null };
  } catch (error) {
    const failed = { ok: false, actionId, skillId: action.skillId || null, runId, status: "failed", errorCode: "ACTION_FAILED", message: error.message };
    if (!dryRun) {
      await saveRun(projectRoot, { ...failed, startedAt, finishedAt: new Date().toISOString() });
      await appendRunLog(projectRoot, actionId + " \u304c\u5931\u6557\u3057\u307e\u3057\u305f\u3002runId=" + runId + " error=" + error.message);
    }
    return failed;
  }
}

function createRunId(actionId) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return (stamp + "-" + actionId.replace(/[^a-z0-9]+/gi, "-")).toLowerCase();
}
