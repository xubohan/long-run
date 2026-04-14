import { randomUUID } from "node:crypto";

import { isoNow } from "./io.js";

function trimText(value) {
  return String(value ?? "").trim();
}

export function normalizeLegacyVerification(verification) {
  return {
    status: verification?.status || "not_run",
    evidence: trimText(verification?.evidence),
  };
}

export function hasLegacyVerifierPass(cycleOutput) {
  const verification = normalizeLegacyVerification(cycleOutput?.verification);
  return verification.status === "pass" && Boolean(verification.evidence);
}

export function evaluateLegacyShippingReadiness(cycleOutput) {
  const verification = normalizeLegacyVerification(cycleOutput?.verification);
  const verifierPassed =
    verification.status === "pass" && Boolean(verification.evidence);
  const reviewStatus =
    cycleOutput?.status === "goal_completed" ? "required" : "not_requested";

  return {
    verification,
    verifierPassed,
    reviewStatus,
    shippingStatus:
      reviewStatus === "required" ? "not_shippable_yet" : "in_progress",
    reasons: [
      ...(verifierPassed
        ? []
        : cycleOutput?.status === "goal_completed"
          ? ["Verifier pass with evidence is required before completion."]
          : []),
      ...(reviewStatus === "required"
        ? ["Independent review is still required before shipping the legacy path."]
        : []),
    ],
  };
}

export function createVerificationRecord({
  id = randomUUID(),
  taskId,
  status = "unclear",
  evidence = "",
}) {
  if (!trimText(taskId)) {
    throw new Error("Verification taskId is required.");
  }

  const now = isoNow();

  return {
    id,
    taskId: trimText(taskId),
    status,
    evidence: trimText(evidence),
    createdAt: now,
    updatedAt: now,
  };
}

export function getLatestVerificationForTask(verifications = [], taskId) {
  return verifications
    .filter((verification) => verification.taskId === taskId)
    .sort((left, right) =>
      String(right.updatedAt || right.createdAt || "").localeCompare(
        String(left.updatedAt || left.createdAt || ""),
      ),
    )[0] ?? null;
}

export function hasPassingTaskVerification(verifications = [], taskId) {
  const latest = getLatestVerificationForTask(verifications, taskId);
  return Boolean(latest?.status === "pass" && trimText(latest?.evidence));
}

export function hasBlockingVerificationFindings(verifications = []) {
  const latestByTask = new Map();

  for (const verification of verifications) {
    const current = latestByTask.get(verification.taskId);
    const candidateTs = String(verification.updatedAt || verification.createdAt || "");
    const currentTs = String(current?.updatedAt || current?.createdAt || "");

    if (!current || candidateTs.localeCompare(currentTs) > 0) {
      latestByTask.set(verification.taskId, verification);
    }
  }

  return Array.from(latestByTask.values()).some((verification) =>
    ["fail", "unclear", "not_run"].includes(verification.status),
  );
}
