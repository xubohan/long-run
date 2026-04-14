import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController } from "../src/lib/controller.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class ReviewRuntimeAdapter {
  async runTask({ agentSession, taskPacket }) {
    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: ["self-test:ok"],
      filesTouched: [],
      questions: [],
      verification:
        agentSession.role === "verifier"
          ? {
              status: "pass",
              evidence: "Verifier reran checks and passed.",
            }
          : null,
      review:
        agentSession.role === "reviewer"
          ? {
              status: "pass",
              summary: "Reviewer reran checks and approved the task.",
              findings: [],
            }
          : null,
    };
  }
}

test("manager acceptance is blocked by review findings until resolved and review pass is recorded", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-review-"));
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-review-1",
    missionDigest: "digest-review",
    runtime: new NativeAgentRuntime({
      adapter: new ReviewRuntimeAdapter(),
    }),
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-review-1",
        title: "Implement reviewable change",
        objective: "Ship a reviewable change safely.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-review-1",
        title: "Verify reviewable change",
        objective: "Validate executor self-test evidence before review.",
      },
    },
  ]);

  const finding = await controller.recordReviewFinding({
    taskId: "task-review-1",
    summary: "Refactor the review gate before delivery.",
    severity: "medium",
  });

  await assert.rejects(
    () => controller.managerAcceptTask({ taskId: "task-review-1" }),
    /review/i,
  );

  await controller.resolveReviewFinding({ findingId: finding.id });

  await assert.rejects(
    () => controller.managerAcceptTask({ taskId: "task-review-1" }),
    /reviewer coverage|awaiting_manager_acceptance/i,
  );

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-review-1",
        title: "Fix reviewable change",
        objective: "Address the resolved review concern before re-review.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-review-1",
        title: "Re-verify reviewable change",
        objective: "Validate the fixed executor output before review.",
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "reviewer",
      taskPacket: {
        id: "task-review-1",
        title: "Review reviewable change",
        objective: "Review the verified change before acceptance.",
      },
    },
  ]);

  const acceptedTask = await controller.managerAcceptTask({
    taskId: "task-review-1",
  });

  assert.equal(acceptedTask.stage, "delivered");
  assert.equal(acceptedTask.status, "accepted");
});

test("review pass requires a reviewer session for the same task", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-review-"));
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-review-2",
    missionDigest: "digest-review",
    runtime: new NativeAgentRuntime({
      adapter: new ReviewRuntimeAdapter(),
    }),
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-review-2",
        title: "Implement reviewable change",
        objective: "Ship a reviewable change safely.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-review-2",
        title: "Verify reviewable change",
        objective: "Validate executor self-test evidence before review.",
      },
    },
  ]);
  await assert.rejects(
    () =>
      controller.recordReviewPass({
        taskId: "task-review-2",
        summary: "Reviewer green.",
      }),
    /reviewer agent session/i,
  );
});

test("stale reviewer pass cannot satisfy manager acceptance after re-verification", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-review-"));
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-review-3",
    missionDigest: "digest-review",
    runtime: new NativeAgentRuntime({
      adapter: new ReviewRuntimeAdapter(),
    }),
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-review-3",
        title: "Implement reviewable change",
        objective: "Ship a reviewable change safely.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await assert.rejects(
    () => controller.managerAcceptTask({ taskId: "task-review-3" }),
    /fresh verifier coverage|awaiting_manager_acceptance/i,
  );

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-review-3",
        title: "Verify reviewable change",
        objective: "Validate executor self-test evidence before review.",
      },
    },
    {
      role: "reviewer",
      taskPacket: {
        id: "task-review-3",
        title: "Review reviewable change",
        objective: "Review the verified change before acceptance.",
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-review-3",
        title: "Fix reviewable change",
        objective: "Apply the requested fix before re-verification.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-review-3",
        title: "Re-verify reviewable change",
        objective: "Validate the fixed executor output before review.",
      },
    },
  ]);

  await assert.rejects(
    () => controller.managerAcceptTask({ taskId: "task-review-3" }),
    /fresh reviewer coverage|awaiting_manager_acceptance/i,
  );

  await controller.dispatchAssignments([
    {
      role: "reviewer",
      taskPacket: {
        id: "task-review-3",
        title: "Re-review reviewable change",
        objective: "Review the fixed, re-verified change before acceptance.",
      },
    },
  ]);

  const acceptedTask = await controller.managerAcceptTask({
    taskId: "task-review-3",
  });
  assert.equal(acceptedTask.stage, "delivered");
  assert.equal(acceptedTask.status, "accepted");
});
