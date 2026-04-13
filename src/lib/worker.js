import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, writeText } from "./io.js";

const schemaPath = fileURLToPath(new URL("./cycle-output-schema.json", import.meta.url));

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

export class CodexCliWorker {
  async runCycle({
    workspaceRoot,
    cycleDir,
    prompt,
    threadId,
    workerConfig,
    onSpawn,
  }) {
    const outputFile = path.join(cycleDir, "last-message.json");
    const stdoutFile = path.join(cycleDir, "codex-stdout.log");
    const stderrFile = path.join(cycleDir, "codex-stderr.log");

    const optionArgs = [
      "--json",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "-o",
      outputFile,
      "--sandbox",
      workerConfig?.sandbox ?? "workspace-write",
      "--cd",
      workspaceRoot,
    ];

    if (workerConfig?.skipGitRepoCheck !== false) {
      optionArgs.push("--skip-git-repo-check");
    }

    if (workerConfig?.dangerouslyBypassSandbox) {
      optionArgs.push("--dangerously-bypass-approvals-and-sandbox");
    }

    if (workerConfig?.model) {
      optionArgs.push("--model", workerConfig.model);
    }

    if (workerConfig?.profile) {
      optionArgs.push("--profile", workerConfig.profile);
    }

    for (const configItem of workerConfig?.config ?? []) {
      optionArgs.push("--config", configItem);
    }

    const args = threadId
      ? ["exec", "resume", ...optionArgs, threadId, "-"]
      : ["exec", ...optionArgs, "-"];

    const child = spawn("codex", args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    if (onSpawn) {
      await onSpawn(child.pid);
    }

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

    return {
      exitCode,
      threadId: parseJsonlThreadId(stdout) || threadId || "",
      structuredOutput,
      stdoutFile,
      stderrFile,
      outputFile,
      stdout,
      stderr,
    };
  }
}
