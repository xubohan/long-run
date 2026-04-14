function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeStringList(values) {
  return (values ?? [])
    .map((value) => normalizeString(value))
    .filter(Boolean);
}

export const CHILD_AGENT_STATUSES = Object.freeze([
  "completed",
  "blocked",
  "needs_input",
  "retry_required",
]);

export const CHILD_AGENT_PRIORITIES = Object.freeze([
  "low",
  "medium",
  "high",
]);

export const VERIFIER_VERDICTS = Object.freeze([
  "pass",
  "fail",
  "unclear",
]);

export const REVIEW_VERDICTS = Object.freeze([
  "pass",
  "fail",
]);

export const REVIEW_SEVERITIES = Object.freeze([
  "low",
  "medium",
  "high",
]);

export function normalizeChildAgentResult(result, context = {}) {
  return {
    agentId: normalizeString(result?.agentId || context.agentId),
    taskId: normalizeString(result?.taskId || context.taskId),
    role: normalizeString(result?.role || context.role),
    threadId: normalizeString(result?.threadId),
    status: normalizeString(result?.status || "completed"),
    summary: normalizeString(result?.summary),
    evidence: normalizeStringList(result?.evidence),
    filesTouched: normalizeStringList(result?.filesTouched),
    questions: (result?.questions ?? []).map((question) => ({
      question: normalizeString(question?.question),
      priority: normalizeString(question?.priority || "medium"),
      toRole: normalizeString(question?.toRole),
    })),
    verification: result?.verification ?? null,
    review: result?.review ?? null,
  };
}

function assertValue(value, label) {
  if (!normalizeString(value)) {
    throw new Error(`Child-agent result ${label} is required.`);
  }
}

function assertEnum(value, validValues, label) {
  if (!validValues.includes(value)) {
    throw new Error(`Invalid child-agent result ${label}: ${value}`);
  }
}

export function validateNormalizedChildAgentResult(result, context = {}) {
  assertValue(result?.agentId, "agentId");
  assertValue(result?.taskId, "taskId");
  assertValue(result?.role, "role");
  assertValue(result?.summary, "summary");
  assertEnum(result?.status, CHILD_AGENT_STATUSES, "status");

  if (normalizeString(context.agentId) && result.agentId !== normalizeString(context.agentId)) {
    throw new Error(
      `Child-agent result agentId mismatch: expected ${normalizeString(context.agentId)}, received ${result.agentId}`,
    );
  }

  if (normalizeString(context.taskId) && result.taskId !== normalizeString(context.taskId)) {
    throw new Error(
      `Child-agent result taskId mismatch: expected ${normalizeString(context.taskId)}, received ${result.taskId}`,
    );
  }

  if (normalizeString(context.role) && result.role !== normalizeString(context.role)) {
    throw new Error(
      `Child-agent result role mismatch: expected ${normalizeString(context.role)}, received ${result.role}`,
    );
  }

  for (const question of result.questions ?? []) {
    assertValue(question.question, "questions[].question");
    assertValue(question.toRole, "questions[].toRole");
    assertEnum(question.priority, CHILD_AGENT_PRIORITIES, "questions[].priority");
  }

  if (result?.verification) {
    assertEnum(result.verification.status, VERIFIER_VERDICTS, "verification.status");
    assertValue(result.verification.evidence, "verification.evidence");
  }

  if (result?.review) {
    assertEnum(result.review.status, REVIEW_VERDICTS, "review.status");
    assertValue(result.review.summary, "review.summary");

    for (const finding of result.review.findings ?? []) {
      assertValue(finding.summary, "review.findings[].summary");
      assertEnum(finding.severity, REVIEW_SEVERITIES, "review.findings[].severity");
    }
  }

  return result;
}
