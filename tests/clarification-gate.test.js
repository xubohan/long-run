import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController, answerV2Run, resumeV2Run, startV2Run } from "../src/lib/controller.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class ClarificationRuntimeAdapter {
  async runTask({ agentSession, taskPacket }) {
    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: agentSession.role === "executor" ? [`self-test:${taskPacket.id}`] : [],
      filesTouched: [],
      questions: [],
    };
  }
}

test("open clarifications block dispatch until answered end-to-end", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-clarify-"));
  const bundle = await startV2Run({
    workspaceRoot,
    missionInput: {
      goal: "Ship v2 runtime",
      definitionOfDone: ["Manager can route native agents safely."],
      clarifications: [],
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
      adapter: new ClarificationRuntimeAdapter(),
    }),
  });

  const clarification = await controller.requestClarification("Which deployment target should v2 prefer?");

  const readOnlyResults = await controller.dispatchAssignments([
    {
      role: "observer",
      taskPacket: {
        id: "task-clarify-observer",
        title: "Inspect deployment targets",
        objective: "Collect read-only deployment facts while clarification is open.",
      },
    },
  ]);
  assert.equal(readOnlyResults.length, 1);

  await assert.rejects(
    () =>
      controller.dispatchAssignments([
        {
          role: "executor",
          taskPacket: {
            id: "task-clarify-1",
            title: "Implement guarded dispatch",
            allowedFiles: ["src/lib/controller.js"],
          },
        },
      ]),
    /clarifications remain open/i,
  );

  const paused = await resumeV2Run({
    workspaceRoot,
    runId: bundle.run.runId,
  });
  assert.equal(paused.run.status, "paused");

  const answered = await answerV2Run({
    workspaceRoot,
    runId: bundle.run.runId,
    clarificationId: clarification.id,
    answer: "Prefer the local repository state path first.",
  });
  assert.equal(answered.run.status, "ready");

  const results = await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-clarify-1",
        title: "Implement guarded dispatch",
        objective: "Guard implementation dispatch behind clarification answers.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  assert.equal(results.length, 1);
});
