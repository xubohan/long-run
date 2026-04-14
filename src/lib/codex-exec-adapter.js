import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir, isoNow, readJson, writeText } from "./io.js";

const childOutputSchemaPath = fileURLToPath(
  new URL("./child-agent-output-schema.json", import.meta.url),
);
const answerOutputSchemaPath = fileURLToPath(
  new URL("./question-answer-output-schema.json", import.meta.url),
);

const DEFAULT_TIMEOUT_MS_BY_ROLE = Object.freeze({
  manager: 90_000,
  planner: 90_000,
  observer: 90_000,
  verifier: 90_000,
  reviewer: 90_000,
  executor: 900_000,
});

const DEFAULT_KILL_GRACE_MS = 1_000;

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

export function renderTomlLiteral(value) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => renderTomlLiteral(item)).join(", ")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, nested]) => `${key} = ${renderTomlLiteral(nested)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }

  return quoteTomlString(value);
}

export function buildConfigOverridesFromTemplate(template) {
  const overrides = [
    `developer_instructions=${renderTomlLiteral(template.developer_instructions)}`,
    `model_reasoning_effort=${renderTomlLiteral(template.model_reasoning_effort)}`,
  ];

  const writableRoots = template.sandbox_workspace_write?.writable_roots ?? [];
  if (writableRoots.length > 0) {
    overrides.push(
      `sandbox_workspace_write.writable_roots=${renderTomlLiteral(writableRoots)}`,
    );
  }

  const skills = template.skills?.config ?? [];
  if (skills.length > 0) {
    overrides.push(`skills.config=${renderTomlLiteral(skills)}`);
  }

  for (const [serverName, serverConfig] of Object.entries(template.mcp_servers ?? {})) {
    for (const [key, value] of Object.entries(serverConfig)) {
      overrides.push(`mcp_servers.${serverName}.${key}=${renderTomlLiteral(value)}`);
    }
  }

  return overrides;
}

function parseJsonlThreadId(stdoutText) {
  for (const line of stdoutText.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "thread.started" && parsed.thread_id) {
        return parsed.thread_id;
      }
    } catch {
      continue;
    }
  }

  return "";
}

function buildAttemptDir({ workspaceRoot, runId, agentId, kind }) {
  return path.join(
    workspaceRoot,
    ".longrun",
    "runs",
    runId,
    "artifacts",
    "native-exec",
    agentId,
    `${kind}-${Date.now()}`,
  );
}

function buildPromptInput({ systemPrompt, taskPrompt }) {
  return [
    systemPrompt.trim(),
    taskPrompt.trim(),
    "Return only JSON matching the configured output schema.",
  ].join("\n\n");
}

function normalizeChildOutput(output) {
  return {
    status: output?.status || "blocked",
    summary: output?.summary || "No summary returned.",
    evidence: Array.isArray(output?.evidence) ? output.evidence : [],
    filesTouched:
      output?.filesTouched ??
      output?.files_touched ??
      [],
    questions: Array.isArray(output?.questions) ? output.questions : [],
    taskProposals: Array.isArray(output?.taskProposals) ? output.taskProposals : [],
    staffing: Array.isArray(output?.staffing) ? output.staffing : [],
    verification: output?.verification ?? null,
    review: output?.review ?? null,
  };
}

function maybeUnref(timer) {
  if (typeof timer?.unref === "function") {
    timer.unref();
  }
}

function tryKill(child, signal) {
  try {
    if (typeof child?.kill === "function") {
      child.kill(signal);
    }
  } catch {
    // best-effort kill only
  }
}

function resolveRoleTimeoutMs(timeoutMsByRole = {}, role) {
  const override = Number(timeoutMsByRole?.[role] ?? 0);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }

  return DEFAULT_TIMEOUT_MS_BY_ROLE[role] ?? 90_000;
}

function readPositiveEnvNumber(name) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

function buildTimeoutMsByRole(timeoutMsByRole = {}) {
  const globalOverride = readPositiveEnvNumber("LONGRUN_NATIVE_AGENT_TIMEOUT_MS");
  const merged = Object.fromEntries(
    Object.keys(DEFAULT_TIMEOUT_MS_BY_ROLE).map((role) => [
      role,
      globalOverride ?? DEFAULT_TIMEOUT_MS_BY_ROLE[role],
    ]),
  );

  for (const role of Object.keys(DEFAULT_TIMEOUT_MS_BY_ROLE)) {
    const envOverride = readPositiveEnvNumber(
      `LONGRUN_NATIVE_AGENT_TIMEOUT_${role.toUpperCase()}_MS`,
    );
    if (envOverride != null) {
      merged[role] = envOverride;
    }
  }

  for (const [role, value] of Object.entries(timeoutMsByRole ?? {})) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      merged[role] = numeric;
    }
  }

  return merged;
}

function resolveKillGraceMs(killGraceMs) {
  const explicit = Number(killGraceMs ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  return readPositiveEnvNumber("LONGRUN_NATIVE_AGENT_KILL_GRACE_MS") ?? DEFAULT_KILL_GRACE_MS;
}

function waitForChildExit(child, { timeoutMs, killGraceMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timeoutId = null;
    let hardKillId = null;
    let forceResolveId = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (hardKillId) {
        clearTimeout(hardKillId);
      }
      if (forceResolveId) {
        clearTimeout(forceResolveId);
      }
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onClose = (code, signal) => {
      finish({
        exitCode: code ?? 1,
        signal: signal ?? "",
        timedOut,
      });
    };

    child.on("error", onError);
    child.on("close", onClose);

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        tryKill(child, "SIGTERM");

        hardKillId = setTimeout(() => {
          tryKill(child, "SIGKILL");

          forceResolveId = setTimeout(() => {
            finish({
              exitCode: 124,
              signal: "SIGKILL",
              timedOut: true,
            });
          }, 250);
          maybeUnref(forceResolveId);
        }, killGraceMs);
        maybeUnref(hardKillId);
      }, timeoutMs);
      maybeUnref(timeoutId);
    }
  });
}

export class CodexExecAdapter {
  constructor({
    codexBin = "codex",
    spawnImpl = spawn,
    defaultConfig = [],
    skipGitRepoCheck = true,
    timeoutMsByRole,
    killGraceMs,
  } = {}) {
    this.codexBin = codexBin;
    this.spawnImpl = spawnImpl;
    this.defaultConfig = defaultConfig;
    this.skipGitRepoCheck = skipGitRepoCheck;
    this.timeoutMsByRole = buildTimeoutMsByRole(timeoutMsByRole);
    this.killGraceMs = resolveKillGraceMs(killGraceMs);
  }

  async runTask({
    agentSession,
    envelope,
    taskPacket,
    template,
    workspaceRoot,
    runId,
  }) {
    const attemptDir = buildAttemptDir({
      workspaceRoot,
      runId,
      agentId: agentSession.agentId,
      kind: "task",
    });
    await ensureDir(attemptDir);

    const outputFile = path.join(attemptDir, "last-message.json");
    const stdoutFile = path.join(attemptDir, "codex-stdout.log");
    const stderrFile = path.join(attemptDir, "codex-stderr.log");
    const promptFile = path.join(attemptDir, "prompt.txt");
    const systemFile = path.join(attemptDir, "system-prompt.txt");

    const prompt = buildPromptInput({
      systemPrompt: `${template.developer_instructions}\n\n${envelope.systemPrompt}`,
      taskPrompt: envelope.taskPrompt,
    });

    await Promise.all([
      writeText(promptFile, prompt),
      writeText(systemFile, template.developer_instructions),
    ]);

    const optionArgs = [
      "--json",
      "--color",
      "never",
      "--output-schema",
      childOutputSchemaPath,
      "-o",
      outputFile,
      "--sandbox",
      template.sandbox_mode,
      "--cd",
      workspaceRoot,
      "--model",
      template.model,
    ];

    if (this.skipGitRepoCheck) {
      optionArgs.push("--skip-git-repo-check");
    }

    for (const configItem of [
      ...this.defaultConfig,
      ...buildConfigOverridesFromTemplate(template),
    ]) {
      optionArgs.push("--config", configItem);
    }

    const args = agentSession.threadId
      ? ["exec", "resume", ...optionArgs, agentSession.threadId, "-"]
      : ["exec", ...optionArgs, "-"];
    const timeoutMs = resolveRoleTimeoutMs(this.timeoutMsByRole, agentSession.role);

    const child = this.spawnImpl(this.codexBin, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const exitResult = await waitForChildExit(child, {
      timeoutMs,
      killGraceMs: this.killGraceMs,
    });

    await Promise.all([
      writeText(stdoutFile, stdout),
      writeText(stderrFile, stderr),
    ]);

    const structuredOutput = await readJson(outputFile, null);

    if (exitResult.timedOut || exitResult.exitCode !== 0 || !structuredOutput) {
      const timeoutSummary = exitResult.timedOut
        ? `codex exec timed out for ${agentSession.role} after ${timeoutMs}ms`
        : "";
      return {
        agentId: agentSession.agentId,
        taskId: taskPacket.id,
        role: agentSession.role,
        threadId: parseJsonlThreadId(stdout) || agentSession.threadId || "",
        status: "blocked",
        summary:
          timeoutSummary ||
          `codex exec failed for ${agentSession.role}: ${String(stderr || stdout).trim() || "no output"}`,
        evidence: [stdoutFile, stderrFile],
        filesTouched: [],
        questions: [],
        artifacts: {
          promptFile,
          stdoutFile,
          stderrFile,
          outputFile,
          attemptDir,
        },
      };
    }

    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: parseJsonlThreadId(stdout) || agentSession.threadId || "",
      ...normalizeChildOutput(structuredOutput),
      artifacts: {
        promptFile,
        stdoutFile,
        stderrFile,
        outputFile,
        attemptDir,
      },
    };
  }

  async answerQuestion({
    questionRecord,
    targetSession,
    envelope,
    taskPacket,
    template,
    workspaceRoot,
    runId,
  }) {
    const attemptDir = buildAttemptDir({
      workspaceRoot,
      runId,
      agentId: targetSession.agentId,
      kind: "answer",
    });
    await ensureDir(attemptDir);

    const outputFile = path.join(attemptDir, "last-message.json");
    const stdoutFile = path.join(attemptDir, "codex-stdout.log");
    const stderrFile = path.join(attemptDir, "codex-stderr.log");

    const prompt = buildPromptInput({
      systemPrompt: `${template.developer_instructions}\n\n${envelope.systemPrompt}`,
      taskPrompt: [
        envelope.taskPrompt,
        `Question to answer for task ${taskPacket.id}: ${questionRecord.question}`,
        "Answer only the question that was asked. Do not broaden scope.",
      ].join("\n\n"),
    });

    const optionArgs = [
      "--json",
      "--color",
      "never",
      "--output-schema",
      answerOutputSchemaPath,
      "-o",
      outputFile,
      "--sandbox",
      template.sandbox_mode,
      "--cd",
      workspaceRoot,
      "--model",
      template.model,
    ];

    if (this.skipGitRepoCheck) {
      optionArgs.push("--skip-git-repo-check");
    }

    for (const configItem of [
      ...this.defaultConfig,
      ...buildConfigOverridesFromTemplate(template),
    ]) {
      optionArgs.push("--config", configItem);
    }

    const args = targetSession.threadId
      ? ["exec", "resume", ...optionArgs, targetSession.threadId, "-"]
      : ["exec", ...optionArgs, "-"];
    const timeoutMs = resolveRoleTimeoutMs(this.timeoutMsByRole, targetSession.role);

    const child = this.spawnImpl(this.codexBin, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const exitResult = await waitForChildExit(child, {
      timeoutMs,
      killGraceMs: this.killGraceMs,
    });

    await Promise.all([
      writeText(stdoutFile, stdout),
      writeText(stderrFile, stderr),
    ]);

    const structuredOutput = await readJson(outputFile, null);
    const threadId = parseJsonlThreadId(stdout) || targetSession.threadId || "";

    if (exitResult.timedOut || exitResult.exitCode !== 0 || !structuredOutput) {
      const timeoutAnswer = exitResult.timedOut
        ? `codex exec timed out while answering after ${timeoutMs}ms`
        : "";
      return {
        id: `answer-${questionRecord.id}`,
        questionId: questionRecord.id,
        fromAgentId: targetSession.agentId,
        threadId,
        answer:
          timeoutAnswer ||
          `codex exec failed while answering: ${String(stderr || stdout).trim() || "no output"}`,
        evidence: [stdoutFile, stderrFile],
      };
    }

    return {
      id: `answer-${questionRecord.id}`,
      questionId: questionRecord.id,
      fromAgentId: targetSession.agentId,
      threadId,
      answer: String(structuredOutput.answer ?? "").trim(),
      evidence: Array.isArray(structuredOutput.evidence) ? structuredOutput.evidence : [],
    };
  }
}
