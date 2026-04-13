import test from "node:test";
import assert from "node:assert/strict";

import { createMissionLock } from "../src/lib/mission.js";

test("createMissionLock produces a stable digest for stable mission content", () => {
  const input = {
    workspaceRoot: "/tmp/workspace",
    goal: "  Build a long-run supervisor  ",
    definitionOfDone: [
      "Mission lock is persisted",
      "Mission lock is persisted",
      "Supervisor can resume a run",
    ],
    constraints: ["Terminal-first", "Terminal-first"],
    nonGoals: ["No web UI"],
    guardrails: ["Pause on high risk"],
  };

  const first = createMissionLock(input);
  const second = createMissionLock(input);

  assert.equal(first.goal, "Build a long-run supervisor");
  assert.deepEqual(first.definitionOfDone, [
    "Mission lock is persisted",
    "Supervisor can resume a run",
  ]);
  assert.equal(first.digest, second.digest);
});
