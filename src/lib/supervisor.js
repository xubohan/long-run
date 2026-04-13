import path from "node:path";

import { buildCyclePrompt } from "./prompt.js";
import { buildFallbackCycleOutput, auditCycle } from "./auditor.js";
import { createMissionLock } from "./mission.js";
import { createInitialPlan, ensureFocusTask, getFocusTask } from "./planner.js";
import {
  appendRunEvent,
  initializeRun,
  loadRunBundle,
  readRecentEvents,
  resolveRunId,
  savePlan,
  saveRun,
} from "./state.js";
import { CodexCliWorker } from "./worker.js";
import { ensureDir, isPidAlive, isoNow, shortText, writeJson, writeText } from "./io.js";

function buildPauseApproval(reason) {
  return {
    required: true,
    reason,
    requestedAt: isoNow(),
    approvedAt: null,
    note: "",
  };
}

export async function startRun({
  workspaceRoot,
  missionInput,
  workerConfig,
  maxCycles = 0,
  worker = new CodexCliWorker(),
}) {
  const mission = createMissionLock({
    workspaceRoot,
    ...missionInput,
  });
  const plan = createInitialPlan(mission);
  const state = await initializeRun({
    workspaceRoot,
    mission,
    plan,
    workerConfig,
    maxCycles,
  });

  return runSupervisor({
    workspaceRoot,
    runId: state.runId,
    worker,
  });
}

export async function resumeRun({
  workspaceRoot,
  runId = "",
  worker = new CodexCliWorker(),
}) {
  const resolvedRunId = await resolveRunId(workspaceRoot, runId);
  if (!resolvedRunId) {
    throw new Error("No run found to resume.");
  }

  return runSupervisor({
    workspaceRoot,
    runId: resolvedRunId,
    worker,
  });
}

export async function approveRun({
  workspaceRoot,
  runId = "",
  note = "",
  resume = true,
  worker = new CodexCliWorker(),
}) {
  const resolvedRunId = await resolveRunId(workspaceRoot, runId);
  if (!resolvedRunId) {
    throw new Error("No run found to approve.");
  }

  const bundle = await loadRunBundle(workspaceRoot, resolvedRunId);
  bundle.run.pendingApproval = {
    ...(bundle.run.pendingApproval ?? {}),
    required: false,
    approvedAt: isoNow(),
    note,
  };
  bundle.run.status = "ready";
  await saveRun(bundle.paths, bundle.run);
  await appendRunEvent(bundle.paths, "run.approved", {
    note,
  });

  if (!resume) {
    return bundle;
  }

  return runSupervisor({
    workspaceRoot,
    runId: resolvedRunId,
    worker,
  });
}

export async function requestStop({
  workspaceRoot,
  runId = "",
  reason = "Stopped by user.",
}) {
  const resolvedRunId = await resolveRunId(workspaceRoot, runId);
  if (!resolvedRunId) {
    throw new Error("No run found to stop.");
  }

  const bundle = await loadRunBundle(workspaceRoot, resolvedRunId);
  bundle.run.stopRequestedAt = isoNow();
  bundle.run.stopReason = reason;
  bundle.run.status = "stopped";
  bundle.run.stoppedAt = isoNow();

  if (isPidAlive(bundle.run.workerPid)) {
    process.kill(bundle.run.workerPid, "SIGTERM");
  }

  if (
    bundle.run.supervisorPid &&
    bundle.run.supervisorPid !== process.pid &&
    isPidAlive(bundle.run.supervisorPid)
  ) {
    process.kill(bundle.run.supervisorPid, "SIGTERM");
  }

  await saveRun(bundle.paths, bundle.run);
  await appendRunEvent(bundle.paths, "run.stop_requested", {
    reason,
  });

  return bundle;
}

export async function loadStatus(workspaceRoot, runId = "") {
  const resolvedRunId = await resolveRunId(workspaceRoot, runId);
  if (!resolvedRunId) {
    throw new Error("No run found.");
  }

  return loadRunBundle(workspaceRoot, resolvedRunId);
}

export async function runSupervisor({
  workspaceRoot,
  runId,
  worker = new CodexCliWorker(),
}) {
  const bundle = await loadRunBundle(workspaceRoot, runId);
  let { mission, plan, run, paths } = bundle;

  if (run.status === "completed" || run.status === "stopped") {
    return bundle;
  }

  run.status = "running";
  run.startedAt = run.startedAt ?? isoNow();
  run.supervisorPid = process.pid;
  run.stopRequestedAt = null;
  await saveRun(paths, run);
  await appendRunEvent(paths, "run.supervisor_started", {
    pid: process.pid,
  });

  while (true) {
    ({ mission, plan, run, paths } = await loadRunBundle(workspaceRoot, runId));

    if (run.stopRequestedAt) {
      run.status = "stopped";
      run.stoppedAt = run.stoppedAt ?? isoNow();
      await saveRun(paths, run);
      await appendRunEvent(paths, "run.stopped", {
        reason: run.stopReason || "Stop requested.",
      });
      return { mission, plan, run, paths };
    }

    if (
      run.pendingApproval?.required &&
      !run.pendingApproval?.approvedAt
    ) {
      run.status = "paused";
      await saveRun(paths, run);
      return { mission, plan, run, paths };
    }

    if (run.maxCycles > 0 && run.currentCycle >= run.maxCycles) {
      run.status = "paused";
      run.pendingApproval = buildPauseApproval(
        `Reached max cycle limit (${run.maxCycles}).`,
      );
      await saveRun(paths, run);
      await appendRunEvent(paths, "run.paused", {
        reason: run.pendingApproval.reason,
      });
      return { mission, plan, run, paths };
    }

    ensureFocusTask(plan);
    const currentTask = getFocusTask(plan);

    if (!currentTask) {
      run.status = "paused";
      run.pendingApproval = buildPauseApproval(
        "No focus task is available while the mission is still open.",
      );
      await saveRun(paths, run);
      await appendRunEvent(paths, "run.paused", {
        reason: run.pendingApproval.reason,
      });
      return { mission, plan, run, paths };
    }

    const cycleNumber = run.currentCycle + 1;
    const cycleDir = path.join(
      paths.artifactsDir,
      `cycle-${String(cycleNumber).padStart(4, "0")}`,
    );
    await ensureDir(cycleDir);

    const recentEvents = await readRecentEvents(paths, 8);
    const prompt = buildCyclePrompt({
      mission,
      plan,
      run,
      currentTask,
      recentEvents,
    });

    await writeText(path.join(cycleDir, "prompt.txt"), prompt);
    await appendRunEvent(paths, "cycle.started", {
      cycle: cycleNumber,
      focusTask: currentTask.title,
    });

    let workerResult;
    try {
      workerResult = await worker.runCycle({
        workspaceRoot,
        cycleDir,
        prompt,
        threadId: run.threadId,
        workerConfig: run.worker,
        onSpawn: async (pid) => {
          run.workerPid = pid;
          run.lastHeartbeatAt = isoNow();
          await saveRun(paths, run);
        },
      });
    } catch (error) {
      workerResult = {
        exitCode: 1,
        threadId: run.threadId,
        structuredOutput: null,
        stdout: "",
        stderr: String(error?.message ?? error),
      };
    }

    run.currentCycle = cycleNumber;
    run.lastHeartbeatAt = isoNow();
    run.workerPid = null;
    run.threadId = workerResult.threadId || run.threadId;

    const cycleOutput =
      workerResult.exitCode === 0 && workerResult.structuredOutput
        ? workerResult.structuredOutput
        : buildFallbackCycleOutput({
            mission,
            message: `Codex cycle failed with exit code ${workerResult.exitCode}. ${shortText(workerResult.stderr || workerResult.stdout || "No extra error output.")}`,
          });

    await writeJson(path.join(cycleDir, "cycle-output.json"), cycleOutput);
    await appendRunEvent(paths, "cycle.completed", {
      cycle: cycleNumber,
      summary: cycleOutput.summary,
      threadId: run.threadId,
    });

    const audit = auditCycle({
      mission,
      run,
      plan,
      cycleOutput,
    });

    plan = audit.plan;
    run = {
      ...run,
      ...audit.runPatch,
      lastDecision: audit.decision,
      lastHeartbeatAt: isoNow(),
    };

    await savePlan(paths, plan);
    await saveRun(paths, run);
    await appendRunEvent(paths, "audit.completed", {
      cycle: cycleNumber,
      decision: audit.decision,
      reason: audit.reason,
    });

    if (audit.decision === "completed") {
      run.status = "completed";
      run.completedAt = isoNow();
      run.pendingApproval = null;
      await saveRun(paths, run);
      await appendRunEvent(paths, "run.completed", {
        cycle: cycleNumber,
        reason: audit.reason,
      });
      return { mission, plan, run, paths };
    }

    if (audit.decision === "pause") {
      run.status = "paused";
      run.pendingApproval = buildPauseApproval(audit.reason);
      await saveRun(paths, run);
      await appendRunEvent(paths, "run.paused", {
        cycle: cycleNumber,
        reason: audit.reason,
      });
      return { mission, plan, run, paths };
    }

    run.status = "running";
    run.pendingApproval = null;
    await saveRun(paths, run);
  }
}
