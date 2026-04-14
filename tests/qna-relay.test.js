import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController } from "../src/lib/controller.js";
import { loadV2ControllerState } from "../src/lib/controller-state.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class RelayRuntimeAdapter {
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

  async answerQuestion({ questionRecord, targetSession }) {
    return {
      id: `answer-${questionRecord.id}`,
      questionId: questionRecord.id,
      fromAgentId: targetSession.agentId,
      answer: `routed-answer-from-${targetSession.role}`,
    };
  }
}

test("controller routes a question through another agent and persists both question and answer", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-qna-"));
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-qna-1",
    missionDigest: "digest-qna",
    runtime: new NativeAgentRuntime({
      adapter: new RelayRuntimeAdapter(),
    }),
  });

  const dispatchResults = await controller.dispatchAssignments([
    {
      role: "observer",
      taskPacket: {
        id: "task-observer",
        title: "Inspect runtime state",
        objective: "Find a runtime fact",
      },
    },
    {
      role: "executor",
      taskPacket: {
        id: "task-executor",
        title: "Implement with observed fact",
        objective: "Use the answer from observer",
        allowedFiles: ["src/lib/controller.js"],
        forbiddenFiles: ["README.md"],
      },
    },
  ]);

  const relay = await controller.relayQuestion({
    fromAgentId: dispatchResults[1].agentSession.agentId,
    toRole: "observer",
    taskId: "task-executor",
    question: "What is the runtime fact?",
    priority: "high",
  });

  const state = await loadV2ControllerState(workspaceRoot, "run-qna-1");

  assert.equal(relay.questionRecord.status, "answered");
  assert.match(relay.answerRecord.answer, /routed-answer-from-observer/);
  assert.equal(state.questions.length, 1);
  assert.equal(state.answers.length, 1);
});
