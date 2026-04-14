import test from "node:test";
import assert from "node:assert/strict";

import { createClarification } from "../src/lib/clarifications.js";
import { evaluateDeliveryGate } from "../src/lib/delivery-gate.js";
import { createQuestion } from "../src/lib/questions.js";
import { createReviewFinding } from "../src/lib/reviews.js";
import { createTaskGraph, createV2Task, setTaskStatus } from "../src/lib/task-graph.js";
import { createVerificationRecord } from "../src/lib/verification.js";

test("delivery gate blocks completion when any hard gate remains open", () => {
  const task = createV2Task({ title: "Implement v2 state contracts" });
  const snapshot = {
    definitionOfDoneAccepted: false,
    taskGraph: createTaskGraph([task]),
    clarifications: [createClarification({ prompt: "Need user clarification" })],
    questions: [
      createQuestion({
        taskId: task.id,
        question: "Should manager choose role counts autonomously?",
        priority: "high",
      }),
    ],
    verifications: [
      createVerificationRecord({
        taskId: task.id,
        status: "unclear",
        evidence: "Verifier still needs explicit self-test proof.",
        actorRole: "verifier",
        actorAgentId: "verifier-1",
      }),
    ],
    reviews: [
      createReviewFinding({
        taskId: task.id,
        summary: "Blocking architecture concern",
        severity: "high",
      }),
    ],
    allMandatoryLoopStagesClosed: false,
  };

  const gate = evaluateDeliveryGate(snapshot);

  assert.equal(gate.completed, false);
  assert.ok(gate.reasons.length >= 5);
});

test("delivery gate completes only when all hard gates are closed", () => {
  const task = createV2Task({ title: "Finalize controller state" });
  setTaskStatus(task, "accepted");

  const gate = evaluateDeliveryGate({
    definitionOfDoneAccepted: true,
    taskGraph: createTaskGraph([task]),
    clarifications: [],
    questions: [],
    verifications: [
      createVerificationRecord({
        taskId: task.id,
        status: "pass",
        evidence: "Verifier confirmed all checks.",
        actorRole: "verifier",
        actorAgentId: "verifier-2",
      }),
    ],
    reviews: [],
    allMandatoryLoopStagesClosed: true,
  });

  assert.equal(gate.completed, true);
  assert.deepEqual(gate.reasons, []);
});
