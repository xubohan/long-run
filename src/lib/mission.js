import { dedupeStrings, hashJson, isoNow, toList } from "./io.js";

function normalizeList(values) {
  return dedupeStrings(
    toList(values).map((value) => String(value ?? "").trim()),
  );
}

export function createMissionLock({
  workspaceRoot,
  goal,
  definitionOfDone,
  constraints = [],
  nonGoals = [],
  guardrails = [],
  clarifications = [],
}) {
  const cleanedGoal = String(goal ?? "").trim();
  const cleanedDefinitionOfDone = normalizeList(definitionOfDone);

  if (!cleanedGoal) {
    throw new Error("Mission goal is required.");
  }

  if (cleanedDefinitionOfDone.length === 0) {
    throw new Error("At least one definition-of-done item is required.");
  }

  const missionCore = {
    version: 1,
    workspaceRoot,
    goal: cleanedGoal,
    definitionOfDone: cleanedDefinitionOfDone,
    constraints: normalizeList(constraints),
    nonGoals: normalizeList(nonGoals),
    guardrails: normalizeList(guardrails),
    clarifications: normalizeList(clarifications),
  };

  return {
    ...missionCore,
    createdAt: isoNow(),
    digest: hashJson(missionCore),
  };
}

export function normalizeMissionInput({
  goal,
  definitionOfDone,
  constraints,
  nonGoals,
  guardrails,
  clarifications,
}) {
  return {
    goal: String(goal ?? "").trim(),
    definitionOfDone: normalizeList(definitionOfDone),
    constraints: normalizeList(constraints),
    nonGoals: normalizeList(nonGoals),
    guardrails: normalizeList(guardrails),
    clarifications: normalizeList(clarifications),
  };
}
