import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  getV2StatePaths,
  initializeV2ControllerState,
  loadV2ControllerState,
} from "../src/lib/controller-state.js";
import { pathExists } from "../src/lib/io.js";

test("initializeV2ControllerState creates controller files and persistence directories", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-v2-"));

  const result = await initializeV2ControllerState({
    workspaceRoot,
    runId: "run-v2-1",
    missionDigest: "digest-1",
  });

  const paths = getV2StatePaths(workspaceRoot, "run-v2-1");

  assert.equal(result.controller.missionDigest, "digest-1");
  assert.equal(await pathExists(paths.controllerFile), true);
  assert.equal(await pathExists(paths.taskGraphFile), true);
  assert.equal(await pathExists(paths.clarificationsDir), true);
  assert.equal(await pathExists(paths.questionsDir), true);
  assert.equal(await pathExists(paths.verificationsDir), true);
  assert.equal(await pathExists(paths.reviewsDir), true);
  assert.equal(await pathExists(paths.agentsDir), true);
});

test("loadV2ControllerState restores empty initialized collections", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-v2-"));
  await initializeV2ControllerState({
    workspaceRoot,
    runId: "run-v2-2",
    missionDigest: "digest-2",
  });

  const state = await loadV2ControllerState(workspaceRoot, "run-v2-2");

  assert.equal(state.controller.runId, "run-v2-2");
  assert.deepEqual(state.clarifications, []);
  assert.deepEqual(state.questions, []);
  assert.deepEqual(state.verifications, []);
  assert.deepEqual(state.reviews, []);
  assert.deepEqual(state.agents, []);
});
