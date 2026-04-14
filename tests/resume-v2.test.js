import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController, answerV2Run, resumeV2Run, startV2Run } from "../src/lib/controller.js";

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
