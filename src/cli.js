#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { normalizeMissionInput } from "./lib/mission.js";
import { readJsonLines } from "./lib/io.js";
import {
  answerManagedRun,
  approveManagedRun,
  loadManagedStatus,
  resumeManagedRun,
  startManagedRun,
  stopManagedRun,
} from "./lib/run-router.js";

function usage() {
  return `Usage:
  longrun start --goal "..." --done "..." [--engine v1|v2]
  longrun status [run_id]
  longrun resume [run_id]
  longrun approve [run_id] [--note "..."] [--no-resume]
  longrun answer [run_id] --clarification-id "..." --answer "..."
  longrun stop [run_id] [--reason "..."]
  longrun logs [run_id] [--tail 30]

Common options for start:
  --goal            Mission goal
  --done            Repeatable definition-of-done item
  --constraint      Repeatable constraint
  --non-goal        Repeatable non-goal
  --guardrail       Repeatable guardrail
  --clarification   Repeatable clarification
  --engine          Run engine (default: v1)
  --model           Codex model override
  --profile         Codex profile
  --sandbox         Sandbox mode (default: workspace-write)
  --max-cycles      Pause after N cycles
  --config          Repeatable codex config override
  --dangerous-bypass
  --skip-git-repo-check`;
}

function parseCommandArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      goal: { type: "string" },
      done: { type: "string", multiple: true },
      constraint: { type: "string", multiple: true },
      "non-goal": { type: "string", multiple: true },
      guardrail: { type: "string", multiple: true },
      clarification: { type: "string", multiple: true },
      engine: { type: "string" },
      model: { type: "string" },
      profile: { type: "string" },
      sandbox: { type: "string" },
      "max-cycles": { type: "string" },
      config: { type: "string", multiple: true },
      note: { type: "string" },
      reason: { type: "string" },
      answer: { type: "string" },
      "clarification-id": { type: "string" },
      tail: { type: "string" },
      "no-resume": { type: "boolean" },
      "dangerous-bypass": { type: "boolean" },
      "skip-git-repo-check": { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  return { values, positionals };
}

async function promptLine(rl, label, required = false) {
  while (true) {
    const answer = String(await rl.question(`${label}: `)).trim();
    if (answer || !required) {
      return answer;
    }
  }
}

async function promptList(rl, label, required = false) {
  const items = [];
  process.stdout.write(`${label}，每行一条，直接回车结束。\n`);

  while (true) {
    const answer = String(await rl.question("> ")).trim();
    if (!answer) {
      if (!required || items.length > 0) {
        return items;
      }
      continue;
    }

    items.push(answer);
  }
}

async function collectMissionInput(values) {
  const initial = normalizeMissionInput({
    goal: values.goal,
    definitionOfDone: values.done ?? [],
    constraints: values.constraint ?? [],
    nonGoals: values["non-goal"] ?? [],
    guardrails: values.guardrail ?? [],
    clarifications: values.clarification ?? [],
  });

  if (initial.goal && initial.definitionOfDone.length > 0) {
    return initial;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "Non-interactive start requires --goal and at least one --done value.",
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const goal = initial.goal || (await promptLine(rl, "目标", true));
    const definitionOfDone =
      initial.definitionOfDone.length > 0
        ? initial.definitionOfDone
        : await promptList(rl, "完成标准", true);
    const constraints =
      initial.constraints.length > 0
        ? initial.constraints
        : await promptList(rl, "约束条件", false);
    const nonGoals =
      initial.nonGoals.length > 0
        ? initial.nonGoals
        : await promptList(rl, "非目标", false);
    const guardrails =
      initial.guardrails.length > 0
        ? initial.guardrails
        : await promptList(rl, "守护边界", false);

    return {
      goal,
      definitionOfDone,
      constraints,
      nonGoals,
      guardrails,
      clarifications: initial.clarifications,
    };
  } finally {
    rl.close();
  }
}

function printStatus(bundle) {
  const currentTask = bundle.plan.tasks.find(
    (task) => task.id === bundle.plan.focusTaskId,
  );

  process.stdout.write(`run_id: ${bundle.run.runId}\n`);
  process.stdout.write(`engine: ${bundle.run.engine}\n`);
  process.stdout.write(`status: ${bundle.run.status}\n`);
  process.stdout.write(`mission_digest: ${bundle.run.missionDigest}\n`);
  process.stdout.write(`cycles: ${bundle.run.currentCycle}\n`);
  process.stdout.write(`thread_id: ${bundle.run.threadId || "none"}\n`);
  process.stdout.write(`focus_task: ${currentTask?.title || "none"}\n`);
  process.stdout.write(`last_decision: ${bundle.run.lastDecision}\n`);
  process.stdout.write(`last_summary: ${bundle.run.lastSummary || "none"}\n`);
  if (bundle.run.pendingApproval?.reason) {
    process.stdout.write(`pending_approval: ${bundle.run.pendingApproval.reason}\n`);
  }
}

async function run() {
  const { values, positionals } = parseCommandArgs(process.argv.slice(2));
  const command = positionals[0];
  const runId = positionals[1] ?? "";
  const workspaceRoot = process.cwd();

  if (values.help || !command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === "start") {
    const missionInput = await collectMissionInput(values);
    const result = await startManagedRun({
      workspaceRoot,
      missionInput,
      engine: values.engine ?? "v1",
      maxCycles: Number(values["max-cycles"] ?? 0),
      workerConfig: {
        model: values.model,
        profile: values.profile,
        sandbox: values.sandbox ?? "workspace-write",
        config: values.config ?? [],
        dangerouslyBypassSandbox: Boolean(values["dangerous-bypass"]),
        skipGitRepoCheck:
          values["skip-git-repo-check"] === undefined
            ? true
            : Boolean(values["skip-git-repo-check"]),
      },
    });
    printStatus(result);
    return;
  }

  if (command === "status") {
    printStatus(await loadManagedStatus(workspaceRoot, runId));
    return;
  }

  if (command === "resume") {
    printStatus(await resumeManagedRun({ workspaceRoot, runId }));
    return;
  }

  if (command === "approve") {
    printStatus(
      await approveManagedRun({
        workspaceRoot,
        runId,
        note: values.note ?? "",
        resume: !values["no-resume"],
      }),
    );
    return;
  }

  if (command === "answer") {
    if (!values["clarification-id"] || !values.answer) {
      throw new Error("answer requires --clarification-id and --answer.");
    }

    printStatus(
      await answerManagedRun({
        workspaceRoot,
        runId,
        clarificationId: values["clarification-id"],
        answer: values.answer,
      }),
    );
    return;
  }

  if (command === "stop") {
    printStatus(
      await stopManagedRun({
        workspaceRoot,
        runId,
        reason: values.reason ?? "Stopped by user.",
      }),
    );
    return;
  }

  if (command === "logs") {
    const bundle = await loadManagedStatus(workspaceRoot, runId);
    const limit = Number(values.tail ?? 30);
    const events = await readJsonLines(bundle.paths.eventsFile);
    for (const event of events.slice(-limit)) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
