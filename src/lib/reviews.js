import { randomUUID } from "node:crypto";

import { isoNow } from "./io.js";

export function createReviewFinding({
  id = randomUUID(),
  taskId,
  summary,
  severity = "medium",
  status = "open",
  kind = "finding",
}) {
  if (!String(taskId ?? "").trim()) {
    throw new Error("Review finding taskId is required.");
  }

  if (!String(summary ?? "").trim()) {
    throw new Error("Review finding summary is required.");
  }

  const now = isoNow();

  return {
    id,
    taskId: String(taskId).trim(),
    summary: String(summary).trim(),
    severity,
    status,
    kind,
    createdAt: now,
    updatedAt: now,
  };
}

export function createReviewPass({
  id = randomUUID(),
  taskId,
  summary = "Review passed.",
}) {
  return createReviewFinding({
    id,
    taskId,
    summary,
    severity: "low",
    status: "resolved",
    kind: "pass",
  });
}

export function resolveReviewFinding(finding) {
  finding.status = "resolved";
  finding.updatedAt = isoNow();
  return finding;
}

export function hasBlockingReviewFindings(findings = []) {
  return findings.some(
    (finding) =>
      finding.kind !== "pass" &&
      finding.status !== "resolved" &&
      finding.severity !== "low",
  );
}

export function hasBlockingTaskReviewFindings(findings = [], taskId) {
  return findings.some(
    (finding) =>
      finding.taskId === taskId &&
      finding.kind !== "pass" &&
      finding.status !== "resolved" &&
      finding.severity !== "low",
  );
}

export function hasTaskReviewRecord(findings = [], taskId) {
  return findings.some((finding) => finding.taskId === taskId);
}

export function hasTaskReviewPass(findings = [], taskId) {
  return findings.some(
    (finding) =>
      finding.taskId === taskId &&
      finding.kind === "pass" &&
      finding.status === "resolved",
  );
}
