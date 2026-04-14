import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController, answerV2Run, resumeV2Run, startV2Run } from "../src/lib/controller.js";
import { loadV2ControllerState } from "../src/lib/controller-state.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class ResumeSupportRuntimeAdapter {
  async runTask({ agentSession, taskPacket }) {
    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: agentSession.threadId || `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: agentSession.role === "executor" ? [`self-test:${taskPacket.id}`] : [],
      filesTouched: [],
      questions: [],
      verification:
        agentSession.role === "verifier"
          ? {
              status: "pass",
              evidence: `Verifier confirmed ${taskPacket.id}.`,
            }
          : null,
      review:
        agentSession.role === "reviewer"
          ? {
              status: "pass",
              summary: `Reviewer approved ${taskPacket.id}.`,
              findings: [],
            }
          : null,
    };
  }
}

test("resumeV2Run preserves clarification backlog and becomes ready after answer path", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-resume-v2-"));
  const bundle = await startV2Run({
    workspaceRoot,
    missionInput: {
      goal: "Resume v2 from persisted state",
      definitionOfDone: ["Resume respects clarification backlog."],
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
  });

  const clarification = await controller.requestClarification("Which repo policy should manager enforce first?");

  const paused = await resumeV2Run({
    workspaceRoot,
    runId: bundle.run.runId,
  });
  assert.equal(paused.run.status, "paused");
  assert.match(paused.run.pendingApproval.reason, /Clarifications remain open|Definition-of-done evidence/);

  const answered = await answerV2Run({
    workspaceRoot,
    runId: bundle.run.runId,
    clarificationId: clarification.id,
    answer: "Project rules come before user instructions.",
  });
  assert.equal(answered.run.status, "ready");
});

test("resumeV2Run auto-dispatches verifier work for executor tasks in self-testing", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-resume-v2-"));
  const runtime = new NativeAgentRuntime({
    adapter: new ResumeSupportRuntimeAdapter(),
  });
  const bundle = await startV2Run({
    workspaceRoot,
    missionInput: {
      goal: "Resume v2 from persisted state",
      definitionOfDone: ["Resume dispatches pending verifier support work."],
    },
    workerConfig: {
      sandbox: "workspace-write",
      config: [],
    },
    runtime,
  });

  const controller = new LongRunController({
    workspaceRoot,
    runId: bundle.run.runId,
    missionDigest: bundle.mission.digest,
    runtime,
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-resume-verifier",
        title: "Implement resume verifier flow",
        objective: "Leave a task in self-testing so resume can dispatch verifier work.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await resumeV2Run({
    workspaceRoot,
    runId: bundle.run.runId,
    runtime,
  });

  const state = await loadV2ControllerState(workspaceRoot, bundle.run.runId);
  assert.equal(state.verifications.length, 1);
  assert.equal(state.verifications[0].status, "pass");
  assert.equal(state.tasks[0].stage, "reviewing");
});
