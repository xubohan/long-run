import test from "node:test";
import assert from "node:assert/strict";

import { buildCyclePrompt } from "../src/lib/prompt.js";

test("cycle prompt injects clarifications, authority precedence, and mandatory loop", () => {
  const prompt = buildCyclePrompt({
    mission: {
      digest: "mission-digest",
      goal: "Ship the feature safely",
      definitionOfDone: ["All checks pass"],
      clarifications: ["Do not use OMX team"],
      constraints: ["Native agents only"],
      nonGoals: ["No UI"],
      guardrails: ["Pause on high risk"],
    },
    plan: {
      focusTaskId: "task-1",
      tasks: [
        {
          id: "task-1",
          title: "Implement the feature",
          rationale: "Required by the mission",
          status: "in_progress",
        },
      ],
    },
    run: {
      runId: "run-1",
      currentCycle: 0,
    },
    currentTask: {
      id: "task-1",
      title: "Implement the feature",
      rationale: "Required by the mission",
    },
    recentEvents: [],
  });

  assert.match(prompt, /Clarifications:/);
  assert.match(prompt, /Do not use OMX team/);
  assert.match(prompt, /Authority precedence:/);
  assert.match(prompt, /1\. Project rules/);
  assert.match(prompt, /Mandatory development loop:/);
  assert.match(prompt, /Legacy shipping gate:/);
  assert.match(prompt, /verification\.status/);
});
