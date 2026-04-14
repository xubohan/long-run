import test from "node:test";
import assert from "node:assert/strict";

import { buildRolePromptEnvelope } from "../src/lib/agent-registry.js";

test("role prompt envelopes carry authority precedence, task scope, and accepted answers", () => {
  const envelope = buildRolePromptEnvelope({
    role: "executor",
    missionDigest: "digest-1",
    taskPacket: {
      id: "task-7",
      title: "Implement verification gate",
      objective: "Add the gate without changing unrelated behavior.",
      allowedFiles: ["src/lib/auditor.js", "tests/supervisor.test.js"],
      forbiddenFiles: ["README.md"],
      acceptanceChecks: ["npm test", "node --check src/lib/auditor.js"],
    },
    acceptedAnswers: ["Use Codex native agents only."],
  });

  assert.match(envelope.systemPrompt, /Authority precedence:/);
  assert.match(envelope.taskPrompt, /Allowed files:/);
  assert.match(envelope.taskPrompt, /src\/lib\/auditor\.js/);
  assert.match(envelope.taskPrompt, /Forbidden files:/);
  assert.match(envelope.taskPrompt, /Accepted answers:/);
  assert.match(envelope.systemPrompt, /Structured output rules:/);
  assert.match(envelope.systemPrompt, /taskProposals, staffing, verification, and review/);
});
