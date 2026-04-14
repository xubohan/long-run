import {
  buildLongRunAgentTemplate,
  materializeLongRunTemplateLayer,
} from "./native-agent-template.js";
import { buildRolePromptEnvelope } from "./agent-registry.js";
import { normalizeChildAgentResult } from "./result-normalizer.js";

export class NativeAgentRuntime {
  constructor({ adapter, templateLayerOptions = {} } = {}) {
    this.adapter = adapter ?? {
      async runTask({ agentSession }) {
        return {
          agentId: agentSession.agentId,
          taskId: agentSession.taskId,
          role: agentSession.role,
          status: "completed",
          summary: "No adapter result provided.",
          evidence: [],
          filesTouched: [],
          questions: [],
        };
      },
      async answerQuestion({ questionRecord, targetSession }) {
        return {
          id: `answer-${questionRecord.id}`,
          questionId: questionRecord.id,
          fromAgentId: targetSession.agentId,
          answer: "No adapter answer provided.",
        };
      },
    };
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
  }) {
    const envelope = buildRolePromptEnvelope({
      role: agentSession.role,
      missionDigest,
      taskPacket,
      acceptedAnswers,
    });

    const rawResult = await this.adapter.runTask({
      agentSession,
      envelope,
      taskPacket,
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
  }) {
    const envelope = buildRolePromptEnvelope({
      role: targetSession.role,
      missionDigest,
      taskPacket,
      acceptedAnswers,
    });

    return this.adapter.answerQuestion({
      questionRecord,
      targetSession,
      envelope,
      taskPacket,
    });
  }
}
