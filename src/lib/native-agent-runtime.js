import {
  buildLongRunAgentTemplate,
  materializeLongRunTemplateLayer,
} from "./native-agent-template.js";
import { buildRolePromptEnvelope } from "./agent-registry.js";
import { normalizeChildAgentResult } from "./result-normalizer.js";
import { CodexExecAdapter } from "./codex-exec-adapter.js";

function dedupeStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function toParentDirectories(filePaths = []) {
  return dedupeStrings(
    filePaths.map((filePath) => {
      const normalized = String(filePath ?? "").trim();
      const lastSlash = normalized.lastIndexOf("/");
      if (lastSlash <= 0) {
        return ".";
      }

      return normalized.slice(0, lastSlash);
    }),
  );
}

export class NativeAgentRuntime {
  constructor({ adapter, templateLayerOptions = {} } = {}) {
    this.adapter = adapter ?? new CodexExecAdapter();
    this.templateLayerOptions = templateLayerOptions;
  }

  materializeTemplates({ targetDir = ".codex/agents", ...options } = {}) {
    return materializeLongRunTemplateLayer({
      targetDir,
      ...this.templateLayerOptions,
      ...options,
    });
  }

  buildTemplateForRole({
    role,
    readRoots = [],
    writeRoots = [],
    skills = [],
    mcpServers = {},
    communication = {},
  }) {
    return buildLongRunAgentTemplate({
      role,
      readRoots,
      writeRoots,
      skills,
      mcpServers,
      communication,
    });
  }

  async runTask({
    agentSession,
    missionDigest,
    taskPacket,
    acceptedAnswers = [],
    workspaceRoot = process.cwd(),
    runId = "adhoc-run",
  }) {
    const envelope = buildRolePromptEnvelope({
      role: agentSession.role,
      missionDigest,
      taskPacket,
      acceptedAnswers,
    });
    const template = this.buildTemplateForRole({
      role: agentSession.role,
      readRoots: taskPacket.readRoots ?? toParentDirectories(taskPacket.allowedFiles),
      writeRoots:
        agentSession.role === "executor"
          ? toParentDirectories(taskPacket.allowedFiles)
          : [],
      communication: {
        mode: "controller-relay",
      },
    });
    this.materializeTemplates({
      targetDir: `${workspaceRoot}/.codex/agents`,
    });

    const rawResult = await this.adapter.runTask({
      agentSession,
      envelope,
      taskPacket,
      template,
      workspaceRoot,
      runId,
    });

    return {
      envelope,
      result: normalizeChildAgentResult(rawResult, {
        agentId: agentSession.agentId,
        taskId: taskPacket.id,
        role: agentSession.role,
      }),
    };
  }

  async answerQuestion({
    questionRecord,
    targetSession,
    missionDigest,
    taskPacket,
    acceptedAnswers = [],
    workspaceRoot = process.cwd(),
    runId = "adhoc-run",
  }) {
    const envelope = buildRolePromptEnvelope({
      role: targetSession.role,
      missionDigest,
      taskPacket,
      acceptedAnswers,
    });
    const template = this.buildTemplateForRole({
      role: targetSession.role,
      readRoots: taskPacket.readRoots ?? toParentDirectories(taskPacket.allowedFiles),
      writeRoots: [],
      communication: {
        mode: "controller-relay",
      },
    });
    this.materializeTemplates({
      targetDir: `${workspaceRoot}/.codex/agents`,
    });

    return this.adapter.answerQuestion({
      questionRecord,
      targetSession,
      envelope,
      taskPacket,
      template,
      workspaceRoot,
      runId,
    });
  }
}
