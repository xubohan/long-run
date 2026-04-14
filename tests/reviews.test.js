import test from "node:test";
import assert from "node:assert/strict";

import {
  createReviewFinding,
  createReviewPass,
  hasBlockingReviewFindings,
  hasTaskReviewPass,
  resolveReviewFinding,
} from "../src/lib/reviews.js";

test("unresolved medium-or-higher review findings remain blocking", () => {
  const finding = createReviewFinding({
    taskId: "task-1",
    summary: "Review found a maintainability issue.",
    severity: "medium",
  });

  assert.equal(hasBlockingReviewFindings([finding]), true);

  resolveReviewFinding(finding);

  assert.equal(hasBlockingReviewFindings([finding]), false);
});

test("task review pass requires reviewer provenance", () => {
  const passing = createReviewPass({
    taskId: "task-2",
    summary: "Reviewer approved the task.",
    actorAgentId: "reviewer-1",
  });
  const missingActor = createReviewPass({
    taskId: "task-2",
    summary: "Reviewer approved the task.",
    actorAgentId: "",
  });

  assert.equal(hasTaskReviewPass([passing], "task-2"), true);
  assert.equal(hasTaskReviewPass([missingActor], "task-2"), false);
});
