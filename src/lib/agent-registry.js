import { randomUUID } from "node:crypto";

import { buildManagerPromptEnvelope } from "./prompts/manager.js";
import { buildPlannerPromptEnvelope } from "./prompts/planner.js";
import { buildObserverPromptEnvelope } from "./prompts/observer.js";
import { buildExecutorPromptEnvelope } from "./prompts/executor.js";
import { buildVerifierPromptEnvelope } from "./prompts/verifier.js";
import { buildReviewerPromptEnvelope } from "./prompts/reviewer.js";

const ROLE_BUILDERS = Object.freeze({
  manager: buildManagerPromptEnvelope,
  planner: buildPlannerPromptEnvelope,
  observer: buildObserverPromptEnvelope,
  executor: buildExecutorPromptEnvelope,
  verifier: buildVerifierPromptEnvelope,
  reviewer: buildReviewerPromptEnvelope,
});

export function getAvailableRoles() {
  return Object.keys(ROLE_BUILDERS);
}

export function buildRolePromptEnvelope({
  role,
  missionDigest,
  taskPacket,
  acceptedAnswers = [],
}) {
  const builder = ROLE_BUILDERS[role];
  if (!builder) {
    throw new Error(`Unknown role: ${role}`);
  }

  return builder({
    missionDigest,
    taskPacket,
    acceptedAnswers,
  });
}

export function createAgentSessionRecord({
  agentId = randomUUID(),
  role,
  taskId,
  threadId = "",
}) {
  return {
    id: agentId,
    agentId,
    role,
    taskId,
    threadId,
    historyKey: `${role}:${agentId}`,
  };
}
