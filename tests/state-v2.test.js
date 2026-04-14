import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  getV2StatePaths,
  initializeV2ControllerState,
  loadV2ControllerState,
  writeV2Record,
} from "../src/lib/controller-state.js";
import { createClarification } from "../src/lib/clarifications.js";
import { createQuestion } from "../src/lib/questions.js";
import { createReviewFinding } from "../src/lib/reviews.js";
import { createV2Task } from "../src/lib/task-graph.js";
import { createVerificationRecord } from "../src/lib/verification.js";
import { writeJson } from "../src/lib/io.js";

test("v2 state reload restores persisted backlog objects and agent identity mapping", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-v2-"));
  await initializeV2ControllerState({
    workspaceRoot,
    runId: "run-v2-3",
    missionDigest: "digest-3",
  });

  const paths = getV2StatePaths(workspaceRoot, "run-v2-3");
  const task = createV2Task({ title: "Implement controller state" });
  const clarification = createClarification({ prompt: "Answer this first" });
  const question = createQuestion({
    taskId: task.id,
    question: "Need repo fact",
    priority: "high",
  });
  const verification = createVerificationRecord({
    taskId: task.id,
    status: "unclear",
  });
  const review = createReviewFinding({
    taskId: task.id,
    summary: "Review still blocking",
    severity: "high",
  });

  await Promise.all([
    writeV2Record(paths.tasksDir, task),
    writeV2Record(paths.clarificationsDir, clarification),
    writeV2Record(paths.questionsDir, question),
    writeJson(path.join(paths.answersDir, "answer-1.json"), {
      id: "answer-1",
      questionId: question.id,
      answer: "Use Codex native agents only.",
    }),
    writeV2Record(paths.verificationsDir, verification),
    writeV2Record(paths.reviewsDir, review),
    writeJson(path.join(paths.agentsDir, "observer-1.json"), {
      id: "observer-1",
      role: "observer",
      threadId: "thread-observer-1",
    }),
  ]);

  const state = await loadV2ControllerState(workspaceRoot, "run-v2-3");

  assert.equal(state.tasks.length, 1);
  assert.equal(state.clarifications.length, 1);
  assert.equal(state.questions.length, 1);
  assert.equal(state.answers.length, 1);
  assert.equal(state.verifications.length, 1);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.agents[0].threadId, "thread-observer-1");
});
