import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController } from "../src/lib/controller.js";
import { loadV2ControllerState } from "../src/lib/controller-state.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class FakeRuntimeAdapter {
  constructor() {
    this.calls = [];
  }

  async runTask({ agentSession, envelope, taskPacket }) {
    this.calls.push({
      agentId: agentSession.agentId,
      role: agentSession.role,
      taskId: taskPacket.id,
      envelope,
    });

    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: [`evidence:${taskPacket.id}`],
      filesTouched: [],
      questions: [],
    };
  }

  async answerQuestion({ questionRecord, targetSession }) {
    return {
      id: `answer-${questionRecord.id}`,
      questionId: questionRecord.id,
      fromAgentId: targetSession.agentId,
      answer: `answer-from-${targetSession.role}`,
    };
  }
}

test("controller dispatch creates at least two isolated child agent sessions", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: new FakeRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-1",
    missionDigest: "digest-1",
    runtime,
  });

  const results = await controller.dispatchAssignments([
    {
      role: "observer",
      taskPacket: {
        id: "task-observer-a",
        title: "Inspect repo A",
        objective: "Find repo fact A",
      },
    },
    {
      role: "observer",
      taskPacket: {
        id: "task-observer-b",
        title: "Inspect repo B",
        objective: "Find repo fact B",
      },
    },
  ]);

  const state = await loadV2ControllerState(workspaceRoot, "run-controller-1");

  assert.equal(results.length, 2);
  assert.equal(state.agents.length, 2);
  assert.notEqual(state.agents[0].historyKey, state.agents[1].historyKey);
  assert.equal(results[0].envelope.systemPrompt, results[1].envelope.systemPrompt);
  assert.notEqual(results[0].envelope.taskPrompt, results[1].envelope.taskPrompt);
});

test("controller can accept a task-level verified integration", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: new FakeRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-2",
    missionDigest: "digest-2",
    runtime,
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-executor-1",
        title: "Implement feature gate",
        objective: "Add the feature gate safely",
        allowedFiles: ["src/lib/auditor.js"],
        forbiddenFiles: ["README.md"],
      },
    },
  ]);

  const acceptedTask = await controller.acceptTaskLevelVerifiedIntegration({
    taskId: "task-executor-1",
    verificationEvidence: "Verifier confirmed task-level integration.",
  });

  assert.equal(acceptedTask.status, "in_progress");
  assert.equal(acceptedTask.stage, "reviewing");
});
