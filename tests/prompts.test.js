import test from "node:test";
import assert from "node:assert/strict";

import { buildRolePromptEnvelope } from "../src/lib/agent-registry.js";
import { buildManagerPromptEnvelope } from "../src/lib/prompts/manager.js";
import { buildPlannerPromptEnvelope } from "../src/lib/prompts/planner.js";

test("role prompt envelopes carry authority precedence, task scope, and accepted answers", () => {
  const envelope = buildRolePromptEnvelope({
    role: "executor",
    missionDigest: "digest-1",
    taskPacket: {
      id: "task-7",
      title: "Implement verification gate",
      objective: "Add the gate without changing unrelated behavior.",
      readRoots: ["src/lib", "tests"],
      allowedFiles: ["src/lib/auditor.js", "tests/supervisor.test.js"],
      forbiddenFiles: ["README.md"],
      acceptanceChecks: ["npm test", "node --check src/lib/auditor.js"],
    },
    acceptedAnswers: ["Use Codex native agents only."],
  });

  assert.match(envelope.systemPrompt, /Authority precedence:/);
  assert.match(envelope.taskPrompt, /Read focus roots:/);
  assert.match(envelope.taskPrompt, /src\/lib/);
  assert.match(envelope.taskPrompt, /Allowed files:/);
  assert.match(envelope.taskPrompt, /src\/lib\/auditor\.js/);
  assert.match(envelope.taskPrompt, /Forbidden files:/);
  assert.match(envelope.taskPrompt, /Accepted answers:/);
  assert.match(envelope.systemPrompt, /Structured output rules:/);
  assert.match(envelope.systemPrompt, /taskProposals, staffing, verification, and review/);
});

test("manager and planner prompts enforce bounded clarification and first-wave planning rules", () => {
  const commonArgs = {
    missionDigest: "digest-2",
    taskPacket: {
      id: "bootstrap-1",
      title: "Bootstrap planning",
      objective: "Clarify and then plan the first executable wave.",
      readRoots: ["src", "tests", "docs"],
      allowedFiles: [],
      forbiddenFiles: [],
      acceptanceChecks: ["Return a bounded first-wave plan."],
    },
    acceptedAnswers: ["Target files are src/lib/controller.js and tests/manager-loop.test.js"],
  };

  const managerEnvelope = buildManagerPromptEnvelope(commonArgs);
  const plannerEnvelope = buildPlannerPromptEnvelope(commonArgs);

  assert.match(managerEnvelope.systemPrompt, /minimum blocking clarification set/i);
  assert.match(managerEnvelope.systemPrompt, /at most 3 high-value questions/i);
  assert.match(managerEnvelope.systemPrompt, /stop clarifying and hand work to the planner/i);
  assert.match(plannerEnvelope.systemPrompt, /bounded first-wave plan directly/i);
  assert.match(plannerEnvelope.systemPrompt, /at most one executor/i);
  assert.match(plannerEnvelope.systemPrompt, /explicit readRoots plus write scope/i);
});
