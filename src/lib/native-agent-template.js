import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SUPPORT_LEVELS = Object.freeze({
  DIRECT: "direct",
  PARTIAL: "partial",
  INDIRECT: "indirect",
  NONE: "none",
});

export const CODEX_EXEC_TEMPLATE_SUPPORT = Object.freeze({
  customAgentFile: {
    level: SUPPORT_LEVELS.DIRECT,
    summary: "Custom agent templates can live under .codex/agents/*.toml.",
  },
  systemPromptTemplate: {
    level: SUPPORT_LEVELS.DIRECT,
    summary: "Use developer_instructions in a custom agent file.",
  },
  modelAndReasoning: {
    level: SUPPORT_LEVELS.DIRECT,
    summary: "Custom agents can pin model and model_reasoning_effort.",
  },
  sandboxMode: {
    level: SUPPORT_LEVELS.DIRECT,
    summary: "Custom agents can set sandbox_mode such as read-only or workspace-write.",
  },
  writableRoots: {
    level: SUPPORT_LEVELS.DIRECT,
    summary: "workspace-write agents can declare sandbox_workspace_write.writable_roots.",
  },
  readScope: {
    level: SUPPORT_LEVELS.PARTIAL,
    summary: "Codex does not expose a hard per-subdirectory read allow-list; enforce read scope with instructions, task packets, and working-root choices.",
  },
  skills: {
    level: SUPPORT_LEVELS.PARTIAL,
    summary: "Custom agents can carry skills.config entries, but this is not a universal hard allow-list over every globally installed skill.",
  },
  mcpServers: {
    level: SUPPORT_LEVELS.DIRECT,
    summary: "Custom agents can include mcp_servers config.",
  },
  mcpToolAllowDeny: {
    level: SUPPORT_LEVELS.DIRECT,
    summary: "Per-MCP server enabled_tools and disabled_tools are supported.",
  },
  directPeerChat: {
    level: SUPPORT_LEVELS.NONE,
    summary: "No native peer-to-peer agent chat surface is exposed in codex exec; use parent-orchestrated relay instead.",
  },
  controllerRelay: {
    level: SUPPORT_LEVELS.INDIRECT,
    summary: "Manager-routed question/answer packets can be implemented as protocol instructions and persisted state.",
  },
});

const ROLE_DEFAULTS = Object.freeze({
  manager: {
    name: "longrun_manager",
    description: "Mission-owning manager that clarifies, staffs, routes, and accepts only after verifier and reviewer pass.",
    sandboxMode: "read-only",
    writeRoots: [],
    roleInstructions: [
      "Clarify key ambiguities before dispatching child work.",
      "Choose role mix, agent counts, task granularity, and boundaries autonomously within project rules.",
      "Do not bypass verifier or reviewer failures.",
    ],
  },
  planner: {
    name: "longrun_planner",
    description: "Task planner that decomposes work into executable packets with explicit gates and boundaries.",
    sandboxMode: "read-only",
    writeRoots: [],
    roleInstructions: [
      "Produce task packets with dependencies, acceptance checks, and retry budgets.",
      "Do not implement code.",
      "Escalate real rule conflicts to the manager instead of rewriting requirements.",
    ],
  },
  observer: {
    name: "longrun_observer",
    description: "Read-only observer that gathers repo, runtime, and environment facts for other agents.",
    sandboxMode: "read-only",
    writeRoots: [],
    roleInstructions: [
      "Stay in fact-finding mode and avoid proposing fixes unless explicitly requested.",
      "Return evidence with paths, commands, or logs whenever possible.",
      "Do not change code.",
    ],
  },
  executor: {
    name: "longrun_executor",
    description: "Implementation agent that changes only the files allowed by its task packet and returns self-test evidence.",
    sandboxMode: "workspace-write",
    writeRoots: [],
    roleInstructions: [
      "Implement only the assigned task packet.",
      "Respect allowed_files and forbidden_files from the task packet.",
      "Provide self-test evidence before requesting verifier review.",
    ],
  },
  verifier: {
    name: "longrun_verifier",
    description: "Independent verifier that checks acceptance criteria, DoD evidence, and runtime behavior.",
    sandboxMode: "read-only",
    writeRoots: [],
    roleInstructions: [
      "Verify against task acceptance checks and definition-of-done evidence.",
      "Return pass, fail, or unclear with concrete evidence.",
      "When you complete, fill verification.status and verification.evidence in the structured result.",
      "Do not edit product code.",
    ],
  },
  reviewer: {
    name: "longrun_reviewer",
    description: "Independent reviewer that checks code quality, architecture, maintainability, and risk.",
    sandboxMode: "read-only",
    writeRoots: [],
    roleInstructions: [
      "Review for code quality, structure, maintainability, and risk.",
      "Surface blocking findings clearly and avoid style-only comments unless they hide a real defect.",
      "When you complete, fill review.status, review.summary, and review.findings in the structured result.",
      "Do not edit product code.",
    ],
  },
});

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function renderTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(", ")}]`;
}

function renderTomlScalar(value) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return renderTomlArray(value);
  }

  return quoteTomlString(value);
}

function renderMultilineString(value) {
  return `"""\n${String(value ?? "").trim()}\n"""`;
}

function normalizeStringList(values) {
  const result = [];
  const seen = new Set();

  for (const value of values ?? []) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function normalizeSkills(skills) {
  return (skills ?? [])
    .map((skill) => ({
      path: String(skill?.path ?? "").trim(),
      enabled: skill?.enabled !== false,
    }))
    .filter((skill) => skill.path);
}

function normalizeMcpServers(mcpServers) {
  return Object.fromEntries(
    Object.entries(mcpServers ?? {})
      .map(([name, config]) => {
        const normalized = {};

        if (config?.enabled !== undefined) {
          normalized.enabled = Boolean(config.enabled);
        }

        const enabledTools = normalizeStringList(config?.enabledTools ?? config?.enabled_tools);
        if (enabledTools.length > 0) {
          normalized.enabled_tools = enabledTools;
        }

        const disabledTools = normalizeStringList(config?.disabledTools ?? config?.disabled_tools);
        if (disabledTools.length > 0) {
          normalized.disabled_tools = disabledTools;
        }

        if (config?.url) {
          normalized.url = String(config.url).trim();
        }

        if (config?.command) {
          normalized.command = String(config.command).trim();
        }

        return [name, normalized];
      })
      .filter(([, config]) => Object.keys(config).length > 0),
  );
}

function buildScopeSection({ readRoots, writeRoots }) {
  const lines = [
    "Scope rules:",
    "- Project rules outrank user instructions, which outrank role semantics, which outrank manager task contracts.",
  ];

  if (readRoots.length > 0) {
    lines.push(`- Treat these directories as your read focus roots: ${readRoots.join(", ")}. Do not broad-scan outside them unless the manager explicitly widens scope.`);
  } else {
    lines.push("- Stay within the task-scoped files and directories named by the manager.");
  }

  if (writeRoots.length > 0) {
    lines.push(`- You may write only within these roots unless the manager changes the boundary: ${writeRoots.join(", ")}.`);
  } else {
    lines.push("- Do not write outside the files explicitly allowed by the current task packet.");
  }

  return lines.join("\n");
}

function buildCommunicationSection(communication) {
  const mode = communication?.mode || "controller-relay";
  const questionPath = communication?.questionPath || ".longrun/runs/<run-id>/questions/";
  const answerPath = communication?.answerPath || ".longrun/runs/<run-id>/answers/";
  const resultPath = communication?.resultPath || ".longrun/runs/<run-id>/artifacts/";

  return [
    "Communication rules:",
    `- Communication mode: ${mode}.`,
    "- Never free-chat with peer agents. Route coordination through the manager/controller.",
    `- Questions for another agent must be emitted as structured question packets under ${questionPath}.`,
    `- Answers from other agents are read back through manager-approved answer packets under ${answerPath}.`,
    `- Final findings, evidence, and status updates must be written as result artifacts under ${resultPath}.`,
  ].join("\n");
}

function buildRoleInstructions(roleDefinition, extraInstructions) {
  return [
    `Role: ${roleDefinition.name}`,
    ...roleDefinition.roleInstructions,
    ...normalizeStringList(extraInstructions),
  ].join("\n");
}

export function getCodexExecTemplateSupportMatrix() {
  return CODEX_EXEC_TEMPLATE_SUPPORT;
}

export function getLongRunRoleDefaults() {
  return ROLE_DEFAULTS;
}

export function buildLongRunAgentTemplate({
  role,
  model = "gpt-5.4",
  reasoningEffort = "xhigh",
  nicknameCandidates = [],
  readRoots = [],
  writeRoots,
  skills = [],
  mcpServers = {},
  communication = {},
  extraInstructions = [],
}) {
  const roleDefinition = ROLE_DEFAULTS[role];

  if (!roleDefinition) {
    throw new Error(`Unknown long-run agent role: ${role}`);
  }

  const normalizedReadRoots = normalizeStringList(readRoots);
  const normalizedWriteRoots = normalizeStringList(
    writeRoots ?? roleDefinition.writeRoots,
  );
  const normalizedSkills = normalizeSkills(skills);
  const normalizedMcpServers = normalizeMcpServers(mcpServers);

  const developerInstructions = [
    "You are a long-run v2 custom Codex agent.",
    "Mandatory development loop: 理解/观察 -> 拆任务 -> 实现 -> 自测 -> verifier验证 -> review -> fix -> 再验证 -> manager验证 -> 交付.",
    buildScopeSection({
      readRoots: normalizedReadRoots,
      writeRoots: normalizedWriteRoots,
    }),
    buildCommunicationSection(communication),
    "Structured output rules: Always return status, summary, evidence, filesTouched, questions, verification, and review. Use null for verification or review when your role does not own them or when the task did not complete.",
    buildRoleInstructions(roleDefinition, extraInstructions),
  ].join("\n\n");

  return {
    name: roleDefinition.name,
    description: roleDefinition.description,
    model,
    model_reasoning_effort: reasoningEffort,
    sandbox_mode: roleDefinition.sandboxMode,
    nickname_candidates: normalizeStringList(nicknameCandidates),
    developer_instructions: developerInstructions,
    sandbox_workspace_write:
      roleDefinition.sandboxMode === "workspace-write" && normalizedWriteRoots.length > 0
        ? { writable_roots: normalizedWriteRoots }
        : null,
    skills: {
      config: normalizedSkills,
    },
    mcp_servers: normalizedMcpServers,
    integration_contract: {
      role,
      read_roots: normalizedReadRoots,
      write_roots: normalizedWriteRoots,
      communication_mode: communication?.mode || "controller-relay",
    },
  };
}

export function createLongRunTemplateLayer({
  readRoots = [],
  writeRootsByRole = {},
  sharedSkills = [],
  sharedMcpServers = {},
  communication = {},
} = {}) {
  const templates = Object.fromEntries(
    Object.keys(ROLE_DEFAULTS).map((role) => [
      role,
      buildLongRunAgentTemplate({
        role,
        readRoots,
        writeRoots: writeRootsByRole[role],
        skills: sharedSkills,
        mcpServers: sharedMcpServers,
        communication,
      }),
    ]),
  );

  return {
    support: getCodexExecTemplateSupportMatrix(),
    templates,
  };
}

export function materializeLongRunTemplateLayer({
  targetDir = ".codex/agents",
  ...layerOptions
} = {}) {
  const layer = createLongRunTemplateLayer(layerOptions);
  const files = {};

  mkdirSync(targetDir, { recursive: true });

  for (const [role, template] of Object.entries(layer.templates)) {
    const outputPath = join(targetDir, `${template.name}.toml`);
    writeFileSync(outputPath, renderAgentTemplateToml(template), "utf8");
    files[role] = outputPath;
  }

  return {
    ...layer,
    targetDir,
    files,
  };
}

export function renderAgentTemplateToml(template) {
  const lines = [
    `name = ${quoteTomlString(template.name)}`,
    `description = ${quoteTomlString(template.description)}`,
    `model = ${quoteTomlString(template.model)}`,
    `model_reasoning_effort = ${quoteTomlString(template.model_reasoning_effort)}`,
    `sandbox_mode = ${quoteTomlString(template.sandbox_mode)}`,
  ];

  if (template.nickname_candidates?.length > 0) {
    lines.push(`nickname_candidates = ${renderTomlArray(template.nickname_candidates)}`);
  }

  lines.push(`developer_instructions = ${renderMultilineString(template.developer_instructions)}`);

  const writableRoots = template.sandbox_workspace_write?.writable_roots ?? [];
  if (writableRoots.length > 0) {
    lines.push("", "[sandbox_workspace_write]", `writable_roots = ${renderTomlArray(writableRoots)}`);
  }

  for (const skill of template.skills?.config ?? []) {
    lines.push(
      "",
      "[[skills.config]]",
      `path = ${quoteTomlString(skill.path)}`,
      `enabled = ${renderTomlScalar(skill.enabled)}`,
    );
  }

  for (const [serverName, serverConfig] of Object.entries(template.mcp_servers ?? {})) {
    lines.push("", `[mcp_servers.${serverName}]`);
    for (const [key, value] of Object.entries(serverConfig)) {
      lines.push(`${key} = ${renderTomlScalar(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
