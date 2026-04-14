const AUTHORITY_ORDER = Object.freeze([
  "project_rules",
  "user_instructions",
  "role_prompt",
  "manager_task_contract",
]);

export const AUTHORITY_PRECEDENCE = Object.freeze(
  Object.fromEntries(
    AUTHORITY_ORDER.map((source, index) => [source, index]),
  ),
);

export function buildAuthorityPromptSection() {
  return [
    "Authority precedence:",
    "1. Project rules",
    "2. User task instructions",
    "3. Child role prompt / role semantics",
    "4. Manager task contract",
    "If lower-precedence instructions conflict with higher-precedence rules, escalate instead of overriding.",
  ].join("\n");
}

export function resolveAuthorityConflict({
  attemptedSource,
  conflictingSource,
}) {
  const attemptedRank = AUTHORITY_PRECEDENCE[attemptedSource];
  const conflictingRank = AUTHORITY_PRECEDENCE[conflictingSource];

  if (attemptedRank === undefined) {
    throw new Error(`Unknown authority source: ${attemptedSource}`);
  }

  if (conflictingRank === undefined) {
    throw new Error(`Unknown authority source: ${conflictingSource}`);
  }

  if (attemptedRank < conflictingRank) {
    return {
      decision: "allow",
      reason: `${attemptedSource} outranks ${conflictingSource}.`,
    };
  }

  if (attemptedRank === conflictingRank) {
    return {
      decision: "escalate",
      reason: `Conflicting instructions share the same authority level (${attemptedSource}).`,
    };
  }

  return {
    decision: "escalate",
    reason: `${attemptedSource} cannot override higher-precedence ${conflictingSource}.`,
  };
}
