import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController, startV2Run } from "../src/lib/controller.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class CompletionRuntimeAdapter {
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

test("pure completion gate completes the run only after verifier, reviewer, and manager gates close", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-complete-"));
  const bundle = await startV2Run({
    workspaceRoot,
    missionInput: {
      goal: "Finish v2 completion routing",
      definitionOfDone: ["Manager can complete only from the pure gate."],
    },
    workerConfig: {
      sandbox: "workspace-write",
      config: [],
    },
  });

  const controller = new LongRunController({
    workspaceRoot,
    runId: bundle.run.runId,
    missionDigest: bundle.mission.digest,
    runtime: new NativeAgentRuntime({
      adapter: new CompletionRuntimeAdapter(),
    }),
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-complete-1",
        title: "Close the pure gate",
        objective: "Finish the v2 loop cleanly.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-complete-1",
        title: "Verify the pure gate",
        objective: "Validate executor self-test evidence before review.",
      },
    },
  ]);

  await controller.acceptTaskLevelVerifiedIntegration({
    taskId: "task-complete-1",
    verificationEvidence: "Verifier evidence mapped to DoD.",
  });
  await controller.dispatchAssignments([
    {
      role: "reviewer",
      taskPacket: {
        id: "task-complete-1",
        title: "Review the pure gate",
        objective: "Review the verified change before manager acceptance.",
      },
    },
  ]);
  await controller.recordReviewPass({
    taskId: "task-complete-1",
    summary: "Review green.",
  });
  await controller.managerAcceptTask({
    taskId: "task-complete-1",
  });

  const finalized = await controller.finalizeRunIfDeliverable();

  assert.equal(finalized.gate.completed, true);
  assert.equal(finalized.run.status, "completed");
  assert.equal(finalized.controllerState.controller.currentPhase, "complete");
});
