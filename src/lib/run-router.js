import {
  appendRunEvent,
  loadRunBundle,
  resolveRunId,
} from "./state.js";
import {
  approveRun,
  loadStatus,
  requestStop,
  resumeRun,
  startRun,
} from "./supervisor.js";
import {
  answerV2Run,
  approveV2Run,
  loadV2Status,
  resumeV2Run,
  startV2Run,
} from "./controller.js";

async function resolveBundle(workspaceRoot, runId = "") {
  const resolvedRunId = await resolveRunId(workspaceRoot, runId);
  if (!resolvedRunId) {
    throw new Error("No run found.");
  }

  const bundle = await loadRunBundle(workspaceRoot, resolvedRunId);
  return {
    resolvedRunId,
    bundle,
  };
}

function resolveEngine(engine = "") {
  return engine === "v2" ? "v2" : "v1";
}

export async function startManagedRun({
  workspaceRoot,
  missionInput,
  workerConfig,
  maxCycles = 0,
  engine = "v1",
  worker,
  autoBootstrap = false,
}) {
  if (resolveEngine(engine) === "v2") {
    return startV2Run({
      workspaceRoot,
      missionInput,
      workerConfig,
      autoBootstrap,
    });
  }

  return startRun({
    workspaceRoot,
    missionInput,
    workerConfig,
    maxCycles,
    worker,
  });
}

export async function loadManagedStatus(workspaceRoot, runId = "") {
  const { bundle } = await resolveBundle(workspaceRoot, runId);
  if (bundle.run.engine === "v2") {
    return loadV2Status(workspaceRoot, bundle.run.runId);
  }

  return loadStatus(workspaceRoot, bundle.run.runId);
}

export async function resumeManagedRun({
  workspaceRoot,
  runId = "",
  worker,
  autoBootstrap = false,
}) {
  const { bundle } = await resolveBundle(workspaceRoot, runId);
  if (bundle.run.engine === "v2") {
    return resumeV2Run({
      workspaceRoot,
      runId: bundle.run.runId,
      autoBootstrap,
    });
  }

  return resumeRun({
    workspaceRoot,
    runId: bundle.run.runId,
    worker,
  });
}

export async function approveManagedRun({
  workspaceRoot,
  runId = "",
  note = "",
  resume = true,
  worker,
}) {
  const { bundle } = await resolveBundle(workspaceRoot, runId);
  if (bundle.run.engine === "v2") {
    const status = await approveV2Run({
      workspaceRoot,
      runId: bundle.run.runId,
      note,
    });

    if (!resume) {
      return status;
    }

    return resumeManagedRun({
      workspaceRoot,
      runId: bundle.run.runId,
      worker,
    });
  }

  return approveRun({
    workspaceRoot,
    runId: bundle.run.runId,
    note,
    resume,
    worker,
  });
}

export async function stopManagedRun({
  workspaceRoot,
  runId = "",
  reason = "Stopped by user.",
}) {
  const { bundle } = await resolveBundle(workspaceRoot, runId);
  await appendRunEvent(bundle.paths, "run.stop.router", {
    engine: bundle.run.engine,
  });

  return requestStop({
    workspaceRoot,
    runId: bundle.run.runId,
    reason,
  });
}

export async function answerManagedRun({
  workspaceRoot,
  runId = "",
  clarificationId,
  answer,
}) {
  const { bundle } = await resolveBundle(workspaceRoot, runId);
  if (bundle.run.engine !== "v2") {
    throw new Error("The answer command is only supported for engine=v2 runs.");
  }

  return answerV2Run({
    workspaceRoot,
    runId: bundle.run.runId,
    clarificationId,
    answer,
  });
}
