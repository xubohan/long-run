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
    verification: output?.verification ?? null,
    review: output?.review ?? null,
  };
}

export class CodexExecAdapter {
  constructor({
    codexBin = "codex",
    spawnImpl = spawn,
    defaultConfig = [],
    skipGitRepoCheck = true,
  } = {}) {
    this.codexBin = codexBin;
    this.spawnImpl = spawnImpl;
    this.defaultConfig = defaultConfig;
    this.skipGitRepoCheck = skipGitRepoCheck;
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

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    await Promise.all([
      writeText(stdoutFile, stdout),
      writeText(stderrFile, stderr),
    ]);

    const structuredOutput = await readJson(outputFile, null);

    if (exitCode !== 0 || !structuredOutput) {
      return {
        agentId: agentSession.agentId,
        taskId: taskPacket.id,
        role: agentSession.role,
        threadId: parseJsonlThreadId(stdout) || agentSession.threadId || "",
        status: "blocked",
        summary: `codex exec failed for ${agentSession.role}: ${String(stderr || stdout).trim() || "no output"}`,
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

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    await Promise.all([
      writeText(stdoutFile, stdout),
      writeText(stderrFile, stderr),
    ]);

    const structuredOutput = await readJson(outputFile, null);
    const threadId = parseJsonlThreadId(stdout) || targetSession.threadId || "";

    if (exitCode !== 0 || !structuredOutput) {
      return {
        id: `answer-${questionRecord.id}`,
        questionId: questionRecord.id,
        fromAgentId: targetSession.agentId,
        threadId,
        answer: `codex exec failed while answering: ${String(stderr || stdout).trim() || "no output"}`,
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
