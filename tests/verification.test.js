import test from "node:test";
import assert from "node:assert/strict";

import {
  createVerificationRecord,
  evaluateLegacyShippingReadiness,
  hasPassingTaskVerification,
  hasLegacyVerifierPass,
} from "../src/lib/verification.js";

test("legacy verifier pass requires pass status and evidence", () => {
  assert.equal(
    hasLegacyVerifierPass({
      verification: { status: "pass", evidence: "Verifier ran npm test successfully." },
    }),
    true,
  );

  assert.equal(
    hasLegacyVerifierPass({
      verification: { status: "pass", evidence: "" },
    }),
    false,
  );
});

test("legacy shipping readiness keeps goal-complete runs review-required", () => {
  const readiness = evaluateLegacyShippingReadiness({
    status: "goal_completed",
    verification: {
      status: "pass",
      evidence: "Verifier confirmed all required checks.",
    },
  });

  assert.equal(readiness.verifierPassed, true);
  assert.equal(readiness.reviewStatus, "required");
  assert.equal(readiness.shippingStatus, "not_shippable_yet");
  assert.match(readiness.reasons.join(" "), /review is still required/i);
});

test("task verification pass requires verifier provenance and evidence", () => {
  const passing = createVerificationRecord({
    taskId: "task-1",
    status: "pass",
    evidence: "Verifier reran checks.",
    actorRole: "verifier",
    actorAgentId: "verifier-1",
  });
  const missingActor = createVerificationRecord({
    taskId: "task-1",
    status: "pass",
    evidence: "Verifier reran checks.",
  });

  assert.equal(hasPassingTaskVerification([passing], "task-1"), true);
  assert.equal(hasPassingTaskVerification([missingActor], "task-1"), false);
});
