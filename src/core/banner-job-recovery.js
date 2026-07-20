export function parseLeaseOwnerPid(ownerId) {
  const match = String(ownerId || "").match(/^(\d+)-/);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessAlive(pid, signalProcess = process.kill) {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

export function classifyAbandonedLease(
  lease,
  { now = Date.now(), signalProcess = process.kill } = {}
) {
  if (!lease || typeof lease !== "object") {
    return { abandoned: false, reason: "missing_lease" };
  }

  const expiresAt = Date.parse(lease.expiresAt || "");
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return { abandoned: true, reason: "lease_expired" };
  }

  const ownerPid = parseLeaseOwnerPid(lease.ownerId);
  if (ownerPid && !isProcessAlive(ownerPid, signalProcess)) {
    return { abandoned: true, reason: "owner_process_missing" };
  }

  return { abandoned: false, reason: ownerPid ? "owner_alive" : "owner_unknown" };
}

export async function scheduleRecoveredImageJob(job, { reconcile, enqueue, reset }) {
  if (typeof reconcile !== "function" || typeof enqueue !== "function" || typeof reset !== "function") {
    throw new TypeError("復旧画像ジョブにはreconcile、enqueue、resetが必要です。");
  }

  let pipeline;
  try {
    pipeline = await reconcile(job);
  } catch (error) {
    await reset(job, "recovery_reconcile_failed");
    return { scheduled: false, reason: "recovery_reconcile_failed", error };
  }

  const expectedInputHash = String(pipeline?.expectedInputHashes?.image || "").trim();
  const recoveredInputHash = String(job?.inputHash || "").trim();
  if (pipeline?.nextNode !== "image" || !expectedInputHash || expectedInputHash !== recoveredInputHash) {
    await reset(job, "pipeline_input_changed");
    return { scheduled: false, reason: "pipeline_input_changed" };
  }

  try {
    const prepared = await enqueue(job);
    if (prepared?.accepted === false && prepared?.claim?.reason === "scheduled") {
      return { scheduled: false, reason: "already_scheduled", prepared };
    }
    if (prepared?.accepted === false) {
      await reset(job, "queue_rejected");
      return { scheduled: false, reason: "queue_rejected", prepared };
    }
    return { scheduled: true, prepared };
  } catch (error) {
    await reset(job, "recovery_schedule_failed");
    return { scheduled: false, reason: "recovery_schedule_failed", error };
  }
}
