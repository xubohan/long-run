import path from "node:path";

import {
  appendJsonl,
  ensureDir,
  isoNow,
  listDirectories,
  makeRunId,
  readJson,
  readJsonLines,
  readText,
  writeJson,
  writeText,
} from "./io.js";

const STATE_DIR = ".longrun";

export function getStateRoot(workspaceRoot) {
  return path.join(workspaceRoot, STATE_DIR);
}

export function getRunsRoot(workspaceRoot) {
  return path.join(getStateRoot(workspaceRoot), "runs");
}

export function getRunPaths(workspaceRoot, runId) {
  const runDir = path.join(getRunsRoot(workspaceRoot), runId);

  return {
    runDir,
    missionFile: path.join(runDir, "mission.lock.json"),
    runFile: path.join(runDir, "run.json"),
    planFile: path.join(runDir, "plan.json"),
    eventsFile: path.join(runDir, "events.jsonl"),
    artifactsDir: path.join(runDir, "artifacts"),
    latestFile: path.join(getStateRoot(workspaceRoot), "latest-run.txt"),
  };
}

export async function initializeRun({
  workspaceRoot,
  mission,
  plan,
  workerConfig,
  maxCycles = 0,
  engine = "v1",
  runtimeVersion = 1,
}) {
  const runId = makeRunId(mission.goal);
  const paths = getRunPaths(workspaceRoot, runId);
  const now = isoNow();

  const run = {
    version: 1,
    engine,
    runtimeVersion,
    runId,
    missionDigest: mission.digest,
    workspaceRoot,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    stoppedAt: null,
    status: "ready",
    currentCycle: 0,
    lastHeartbeatAt: now,
    lastDecision: "ready",
    lastSummary: "",
    lastAudit: null,
    shippingStatus: "in_progress",
    reviewStatus: "not_requested",
    noProgressCount: 0,
    issueCounts: {},
    pendingApproval: null,
    stopRequestedAt: null,
    stopReason: null,
    threadId: null,
    supervisorPid: null,
    workerPid: null,
    maxCycles,
    worker: {
      backend: "codex-cli",
      sandbox: workerConfig?.sandbox ?? "workspace-write",
      model: workerConfig?.model ?? "",
      profile: workerConfig?.profile ?? "",
      skipGitRepoCheck: workerConfig?.skipGitRepoCheck ?? true,
      dangerouslyBypassSandbox:
        workerConfig?.dangerouslyBypassSandbox ?? false,
      config: workerConfig?.config ?? [],
    },
  };

  await ensureDir(paths.runDir);
  await ensureDir(paths.artifactsDir);
  await writeJson(paths.missionFile, mission);
  await writeJson(paths.planFile, plan);
  await writeJson(paths.runFile, run);
  await writeText(paths.latestFile, `${runId}\n`);
  await appendRunEvent(paths, "run.created", {
    runId,
    missionDigest: mission.digest,
  });

  return { runId, mission, plan, run, paths };
}

export async function loadRunBundle(workspaceRoot, runId) {
  const paths = getRunPaths(workspaceRoot, runId);
  const [mission, plan, run] = await Promise.all([
    readJson(paths.missionFile),
    readJson(paths.planFile),
    readJson(paths.runFile),
  ]);

  if (!mission || !plan || !run) {
    throw new Error(`Run ${runId} is incomplete or missing state files.`);
  }

  return { mission, plan, run, paths };
}

export async function saveRun(paths, run) {
  await writeJson(paths.runFile, {
    ...run,
    updatedAt: isoNow(),
  });
}

export async function savePlan(paths, plan) {
  await writeJson(paths.planFile, {
    ...plan,
    updatedAt: isoNow(),
  });
}

export async function appendRunEvent(paths, type, payload = {}) {
  await appendJsonl(paths.eventsFile, {
    timestamp: isoNow(),
    type,
    payload,
  });
}

export async function resolveRunId(workspaceRoot, explicitRunId = "") {
  if (explicitRunId) {
    return explicitRunId;
  }

  const latestFile = path.join(getStateRoot(workspaceRoot), "latest-run.txt");
  const latest = (await readText(latestFile, "")).trim();
  if (latest) {
    return latest;
  }

  const runIds = await listDirectories(getRunsRoot(workspaceRoot));
  return runIds[0] ?? "";
}

export async function readRecentEvents(paths, limit = 12) {
  const events = await readJsonLines(paths.eventsFile);
  return events.slice(-limit);
}
