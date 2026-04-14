import test from "node:test";
import assert from "node:assert/strict";

import {
  createReviewFinding,
  hasBlockingReviewFindings,
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
