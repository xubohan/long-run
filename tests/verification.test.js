import test from "node:test";
import assert from "node:assert/strict";

import {
  createVerificationRecord,
  evaluateLegacyShippingReadiness,
  hasFreshPassingTaskVerification,
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

test("fresh task verification pass must be newer than the latest execution", () => {
  const olderPass = createVerificationRecord({
    taskId: "task-2",
    status: "pass",
    evidence: "Verifier reran checks.",
    actorRole: "verifier",
    actorAgentId: "verifier-2",
  });
  olderPass.updatedAt = "2026-04-14T10:00:00.000Z";

  const newerPass = createVerificationRecord({
    taskId: "task-2",
    status: "pass",
    evidence: "Verifier reran checks again.",
    actorRole: "verifier",
    actorAgentId: "verifier-2",
  });
  newerPass.updatedAt = "2026-04-14T10:05:00.000Z";

  assert.equal(
    hasFreshPassingTaskVerification([olderPass], "task-2", "2026-04-14T10:01:00.000Z"),
    false,
  );
  assert.equal(
    hasFreshPassingTaskVerification(
      [olderPass, newerPass],
      "task-2",
      "2026-04-14T10:01:00.000Z",
    ),
    true,
  );
});
