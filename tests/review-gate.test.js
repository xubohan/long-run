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

  await controller.acceptTaskLevelVerifiedIntegration({
    taskId: "task-review-1",
    verificationEvidence: "Verifier passed with evidence.",
  });

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
    /reviewer coverage/i,
  );

  await controller.recordReviewPass({
    taskId: "task-review-1",
    summary: "Reviewer reran checks and approved the task.",
  });

  const acceptedTask = await controller.managerAcceptTask({
    taskId: "task-review-1",
  });

  assert.equal(acceptedTask.stage, "delivered");
  assert.equal(acceptedTask.status, "accepted");
});
