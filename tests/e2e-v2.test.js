import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  LongRunController,
  answerV2Run,
  resumeV2Run,
  startV2Run,
} from "../src/lib/controller.js";
import { loadV2ControllerState } from "../src/lib/controller-state.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class EndToEndRuntimeAdapter {
  constructor() {
    this.verifierAttempts = new Map();
  }

  async runTask({ agentSession, taskPacket, envelope }) {
    const verifierAttempt =
      agentSession.role === "verifier"
        ? (this.verifierAttempts.get(taskPacket.id) ?? 0) + 1
        : 0;
    if (agentSession.role === "verifier") {
      this.verifierAttempts.set(taskPacket.id, verifierAttempt);
    }

    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: agentSession.threadId || `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: [`self-test:${taskPacket.id}`],
      filesTouched: agentSession.role === "executor" ? ["src/lib/controller.js"] : [],
      questions: [],
      envelopeDigest: `${envelope.role}:${taskPacket.id}`,
      verification:
        agentSession.role === "verifier"
          ? {
              status: verifierAttempt === 1 ? "fail" : "pass",
              evidence:
                verifierAttempt === 1
                  ? `Verifier found a missing fix path for ${taskPacket.id}.`
                  : `Verifier confirmed ${taskPacket.id}.`,
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

  async answerQuestion({ questionRecord, targetSession }) {
    return {
      id: `answer-${questionRecord.id}`,
      questionId: questionRecord.id,
      fromAgentId: targetSession.agentId,
      answer: `answer-from-${targetSession.role}`,
    };
  }
}

test("v2 e2e flow enforces clarification, relay, verifier/reviewer gates, resume, and pure completion", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-e2e-v2-"));
  const started = await startV2Run({
    workspaceRoot,
    missionInput: {
      goal: "Deliver the native multi-agent controller loop",
      definitionOfDone: ["Pure completion gate controls final delivery."],
    },
    workerConfig: {
      sandbox: "workspace-write",
      config: [],
    },
  });

  const runtime = new NativeAgentRuntime({
    adapter: new EndToEndRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: started.run.runId,
    missionDigest: started.mission.digest,
    runtime,
  });

  const clarification = await controller.requestClarification("Should the manager route answers through controller state only?");
  await assert.rejects(
    () =>
      controller.dispatchAssignments([
        {
          role: "executor",
          taskPacket: {
            id: "task-executor",
            title: "Implement controller relay",
            allowedFiles: ["src/lib/controller.js"],
          },
        },
      ]),
    /clarifications remain open/i,
  );

  await answerV2Run({
    workspaceRoot,
    runId: started.run.runId,
    clarificationId: clarification.id,
    answer: "Yes, all answers must go through controller state.",
  });

  const firstWave = await controller.dispatchAssignments([
    {
      role: "observer",
      taskPacket: {
        id: "task-observer-a",
        title: "Inspect repo state A",
        objective: "Collect state fact A",
      },
    },
    {
      role: "observer",
      taskPacket: {
        id: "task-observer-b",
        title: "Inspect repo state B",
        objective: "Collect state fact B",
      },
    },
    {
      role: "executor",
      taskPacket: {
        id: "task-executor",
        title: "Implement controller relay",
        objective: "Use answered facts safely.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  assert.equal(firstWave.length, 3);
  assert.equal(firstWave[0].envelope.systemPrompt, firstWave[1].envelope.systemPrompt);
  assert.notEqual(firstWave[0].envelope.taskPrompt, firstWave[1].envelope.taskPrompt);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-executor",
        title: "Verify controller relay",
        objective: "Validate executor self-test evidence before review.",
      },
    },
  ]);

  const relay = await controller.relayQuestion({
    fromAgentId: firstWave[2].agentSession.agentId,
    toRole: "observer",
    taskId: "task-executor",
    question: "What controller fact should executor use?",
    priority: "high",
  });
  assert.match(relay.answerRecord.answer, /answer-from-observer/);
  const finding = await controller.recordReviewFinding({
    taskId: "task-executor",
    summary: "Reviewer requires a cleaner relay contract.",
    severity: "medium",
  });

  const interrupted = await resumeV2Run({
    workspaceRoot,
    runId: started.run.runId,
  });
  assert.equal(interrupted.run.status, "paused");

  const resumedController = new LongRunController({
    workspaceRoot,
    runId: started.run.runId,
    missionDigest: started.mission.digest,
    runtime,
  });

  const secondWave = await resumedController.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-executor",
        title: "Implement controller relay",
        objective: "Fix verifier and reviewer findings.",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  assert.equal(firstWave[2].agentSession.agentId, secondWave[0].agentSession.agentId);
  assert.equal(firstWave[2].agentSession.threadId, secondWave[0].agentSession.threadId);

  await resumedController.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-executor",
        title: "Verify controller relay",
        objective: "Validate the fixed executor output before review.",
      },
    },
  ]);

  await resumedController.resolveReviewFinding({ findingId: finding.id });
  await resumedController.dispatchAssignments([
    {
      role: "reviewer",
      taskPacket: {
        id: "task-executor",
        title: "Review controller relay",
        objective: "Review the verified fix before manager acceptance.",
      },
    },
  ]);
  await resumedController.managerAcceptTask({
    taskId: "task-executor",
  });

  const finalized = await resumedController.finalizeRunIfDeliverable();
  const persisted = await loadV2ControllerState(workspaceRoot, started.run.runId);

  assert.equal(finalized.gate.completed, true);
  assert.equal(finalized.run.status, "completed");
  assert.equal(persisted.answers.length, 1);
  assert.equal(persisted.questions[0].status, "answered");
});
