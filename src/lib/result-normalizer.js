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

export const CHILD_AGENT_ROLES = Object.freeze([
  "manager",
  "planner",
  "observer",
  "executor",
  "verifier",
  "reviewer",
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

function normalizeTaskProposal(proposal) {
  return {
    id: normalizeString(proposal?.id),
    title: normalizeString(proposal?.title),
    objective: normalizeString(proposal?.objective),
    role: normalizeString(proposal?.role),
    dependencies: normalizeStringList(proposal?.dependencies),
    acceptanceChecks: normalizeStringList(proposal?.acceptanceChecks),
    readRoots: normalizeStringList(proposal?.readRoots),
    allowedFiles: normalizeStringList(proposal?.allowedFiles),
    forbiddenFiles: normalizeStringList(proposal?.forbiddenFiles),
  };
}

function normalizeStaffingEntry(entry) {
  return {
    role: normalizeString(entry?.role),
    count: Number(entry?.count ?? 0),
    rationale: normalizeString(entry?.rationale),
  };
}

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
    taskProposals: (result?.taskProposals ?? []).map(normalizeTaskProposal),
    staffing: (result?.staffing ?? []).map(normalizeStaffingEntry),
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
    assertEnum(question.toRole, CHILD_AGENT_ROLES, "questions[].toRole");
  }

  for (const proposal of result.taskProposals ?? []) {
    assertValue(proposal.id, "taskProposals[].id");
    assertValue(proposal.title, "taskProposals[].title");
    assertValue(proposal.objective, "taskProposals[].objective");
    assertEnum(proposal.role, CHILD_AGENT_ROLES, "taskProposals[].role");
  }

  for (const staffingEntry of result.staffing ?? []) {
    assertEnum(staffingEntry.role, CHILD_AGENT_ROLES, "staffing[].role");
    if (!Number.isInteger(staffingEntry.count) || staffingEntry.count < 1) {
      throw new Error(`Invalid child-agent result staffing[].count: ${staffingEntry.count}`);
    }
    assertValue(staffingEntry.rationale, "staffing[].rationale");
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
