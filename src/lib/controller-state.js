import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureDir, isoNow, readJson, writeJson } from "./io.js";
import { getRunPaths } from "./state.js";
import { createTaskGraph } from "./task-graph.js";

function recordFilePath(dirPath, id) {
  return path.join(dirPath, `${id}.json`);
}

async function readCollection(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();

    return Promise.all(
      files.map((fileName) => readJson(path.join(dirPath, fileName))),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export function getV2StatePaths(workspaceRoot, runId) {
  const { runDir } = getRunPaths(workspaceRoot, runId);

  return {
    runDir,
    controllerFile: path.join(runDir, "controller.json"),
    taskGraphFile: path.join(runDir, "task-graph.json"),
    tasksDir: path.join(runDir, "tasks"),
    clarificationsDir: path.join(runDir, "clarifications"),
    questionsDir: path.join(runDir, "questions"),
    answersDir: path.join(runDir, "answers"),
    verificationsDir: path.join(runDir, "verifications"),
    reviewsDir: path.join(runDir, "reviews"),
    agentsDir: path.join(runDir, "agents"),
  };
}

export async function initializeV2ControllerState({
  workspaceRoot,
  runId,
  missionDigest,
}) {
  const paths = getV2StatePaths(workspaceRoot, runId);
  const now = isoNow();
  const controller = {
    version: 2,
    runId,
    missionDigest,
    createdAt: now,
    updatedAt: now,
    currentPhase: "understanding",
    acceptedEvidence: [],
  };
  const taskGraph = createTaskGraph();

  await Promise.all([
    ensureDir(paths.runDir),
    ensureDir(paths.tasksDir),
    ensureDir(paths.clarificationsDir),
    ensureDir(paths.questionsDir),
    ensureDir(paths.answersDir),
    ensureDir(paths.verificationsDir),
    ensureDir(paths.reviewsDir),
    ensureDir(paths.agentsDir),
  ]);

  await Promise.all([
    writeJson(paths.controllerFile, controller),
    writeJson(paths.taskGraphFile, taskGraph),
  ]);

  return {
    paths,
    controller,
    taskGraph,
  };
}

export async function writeV2Record(dirPath, record) {
  await writeJson(recordFilePath(dirPath, record.id), record);
}

export async function saveV2Controller(paths, controller) {
  await writeJson(paths.controllerFile, {
    ...controller,
    updatedAt: isoNow(),
  });
}

export async function saveV2TaskGraph(paths, taskGraph) {
  await writeJson(paths.taskGraphFile, {
    ...taskGraph,
    updatedAt: isoNow(),
  });
}

export async function loadV2ControllerState(workspaceRoot, runId) {
  const paths = getV2StatePaths(workspaceRoot, runId);
  const [
    controller,
    taskGraph,
    tasks,
    clarifications,
    questions,
    answers,
    verifications,
    reviews,
    agents,
  ] = await Promise.all([
    readJson(paths.controllerFile, null),
    readJson(paths.taskGraphFile, createTaskGraph()),
    readCollection(paths.tasksDir),
    readCollection(paths.clarificationsDir),
    readCollection(paths.questionsDir),
    readCollection(paths.answersDir),
    readCollection(paths.verificationsDir),
    readCollection(paths.reviewsDir),
    readCollection(paths.agentsDir),
  ]);

  return {
    paths,
    controller,
    taskGraph,
    tasks,
    clarifications,
    questions,
    answers,
    verifications,
    reviews,
    agents,
  };
}
