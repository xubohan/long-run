import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRolePromptEnvelope,
  getAvailableRoles,
} from "../src/lib/agent-registry.js";

function makeTaskPacket(overrides = {}) {
  return {
    id: "task-1",
    title: "Inspect controller state",
    objective: "Confirm the new state contract works.",
    allowedFiles: ["src/lib/controller-state.js"],
    forbiddenFiles: ["README.md"],
    acceptanceChecks: ["npm test"],
    ...overrides,
  };
}

test("registry exposes the baseline long-run roles", () => {
  assert.deepEqual(getAvailableRoles(), [
    "manager",
    "planner",
    "observer",
    "executor",
    "verifier",
    "reviewer",
  ]);
});

test("same role reuses one system prompt while task prompt stays task-specific", () => {
  const first = buildRolePromptEnvelope({
    role: "observer",
    missionDigest: "digest-1",
    taskPacket: makeTaskPacket({ id: "task-a", title: "Observe A" }),
  });
  const second = buildRolePromptEnvelope({
    role: "observer",
    missionDigest: "digest-1",
    taskPacket: makeTaskPacket({ id: "task-b", title: "Observe B" }),
  });

  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.notEqual(first.taskPrompt, second.taskPrompt);
});
