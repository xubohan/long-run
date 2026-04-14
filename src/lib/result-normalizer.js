function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeStringList(values) {
  return (values ?? [])
    .map((value) => normalizeString(value))
    .filter(Boolean);
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
    verification: result?.verification ?? null,
  };
}
