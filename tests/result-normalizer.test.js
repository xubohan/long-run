import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeChildAgentResult,
  validateNormalizedChildAgentResult,
} from "../src/lib/result-normalizer.js";

test("child-agent result validation rejects task and role mismatches", () => {
  const normalized = normalizeChildAgentResult(
    {
      agentId: "agent-1",
      taskId: "wrong-task",
      role: "observer",
      status: "completed",
      summary: "Observed repo state.",
      evidence: [],
      filesTouched: [],
      questions: [],
    },
    {
      agentId: "agent-1",
      taskId: "task-1",
      role: "observer",
    },
  );

  assert.throws(
    () =>
      validateNormalizedChildAgentResult(normalized, {
        agentId: "agent-1",
        taskId: "task-1",
        role: "observer",
      }),
    /taskId mismatch/i,
  );
});

test("child-agent result validation rejects blank summaries and invalid question priorities", () => {
  const normalized = normalizeChildAgentResult({
    agentId: "agent-2",
    taskId: "task-2",
    role: "observer",
    status: "completed",
    summary: "   ",
    evidence: [],
    filesTouched: [],
    questions: [
      {
        question: "Need more context",
        priority: "urgent",
        toRole: "manager",
      },
    ],
  });

  assert.throws(
    () => validateNormalizedChildAgentResult(normalized),
    /summary is required|questions\[\]\.priority/i,
  );
});

test("child-agent result validation rejects invalid task proposals and staffing entries", () => {
  const normalized = normalizeChildAgentResult({
    agentId: "agent-3",
    taskId: "task-3",
    role: "planner",
    status: "completed",
    summary: "Produced planning output.",
    evidence: [],
    filesTouched: [],
    questions: [],
    taskProposals: [
      {
        id: "proposal-1",
        title: "Broken proposal",
        objective: "Missing a valid role.",
        role: "writer",
        dependencies: [],
        acceptanceChecks: [],
        allowedFiles: [],
        forbiddenFiles: [],
      },
    ],
    staffing: [
      {
        role: "observer",
        count: 0,
        rationale: "Invalid count",
      },
    ],
  });

  assert.throws(
    () => validateNormalizedChildAgentResult(normalized),
    /taskProposals\[\]\.role|staffing\[\]\.count/i,
  );
});
