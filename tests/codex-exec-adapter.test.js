import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

import {
  CodexExecAdapter,
  buildConfigOverridesFromTemplate,
} from "../src/lib/codex-exec-adapter.js";

test("config overrides are derived from the agent template contract", () => {
  const overrides = buildConfigOverridesFromTemplate({
    developer_instructions: "Be strict.",
    model_reasoning_effort: "xhigh",
    sandbox_workspace_write: {
      writable_roots: ["src/lib"],
    },
    skills: {
      config: [{ path: "/tmp/skill", enabled: true }],
    },
    mcp_servers: {
      notion: {
        enabled_tools: ["fetch"],
        disabled_tools: ["update"],
      },
    },
  });

  assert.match(overrides.join("\n"), /developer_instructions=/);
  assert.match(overrides.join("\n"), /model_reasoning_effort/);
  assert.match(overrides.join("\n"), /sandbox_workspace_write\.writable_roots/);
  assert.match(overrides.join("\n"), /skills\.config/);
  assert.match(overrides.join("\n"), /mcp_servers\.notion\.enabled_tools/);
});

test("config overrides disable inherited MCP servers that the template does not allow", () => {
  const overrides = buildConfigOverridesFromTemplate({
    developer_instructions: "Be strict.",
    model_reasoning_effort: "xhigh",
    sandbox_workspace_write: null,
    skills: { config: [] },
    mcp_servers: {
      docs: {
        enabled: true,
        enabled_tools: ["fetch"],
      },
    },
  }, {
    inheritedMcpServerNames: ["notion", "docs"],
  });

  assert.match(overrides.join("\n"), /mcp_servers\.docs\.enabled=true/);
  assert.match(overrides.join("\n"), /mcp_servers\.docs\.enabled_tools=/);
  assert.match(overrides.join("\n"), /mcp_servers\.notion\.enabled=false/);
});

test("codex exec adapter parses structured task output and thread id", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-codex-adapter-"));
  const seen = [];

  const spawnImpl = (bin, args) => {
    seen.push({ bin, args });

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {
        const outputIndex = args.indexOf("-o");
        const outputFile = args[outputIndex + 1];
        Promise.resolve(
          writeFile(
            outputFile,
            JSON.stringify({
              status: "completed",
              summary: "Observed package metadata.",
              evidence: ["package.json:name=long-run"],
              filesTouched: [],
              questions: [],
              taskProposals: [],
              staffing: [],
              verification: null,
              review: null,
            }),
          ),
        ).then(() => {
          child.stdout.emit(
            "data",
            Buffer.from(JSON.stringify({ type: "thread.started", thread_id: "thread-smoke-1" })),
          );
          child.emit("close", 0);
        });
      },
    };

    return child;
  };

  const adapter = new CodexExecAdapter({
    spawnImpl,
  });

  const result = await adapter.runTask({
    agentSession: {
      agentId: "agent-1",
      role: "observer",
      taskId: "task-1",
      threadId: "",
    },
    envelope: {
      systemPrompt: "System prompt",
      taskPrompt: "Read package.json",
    },
    taskPacket: {
      id: "task-1",
      title: "Observe package metadata",
    },
    template: {
      developer_instructions: "Stay read-only.",
      sandbox_mode: "read-only",
      model: "gpt-5.4",
      model_reasoning_effort: "xhigh",
      skills: { config: [] },
      mcp_servers: {},
      sandbox_workspace_write: null,
    },
    workspaceRoot,
    runId: "run-1",
  });

  assert.equal(seen[0].bin, "codex");
  assert.deepEqual(seen[0].args.slice(0, 2), ["exec", "--json"]);
  assert.equal(result.threadId, "thread-smoke-1");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.evidence, ["package.json:name=long-run"]);
});

test("codex exec adapter times out hanging child runs and returns a blocked result", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-codex-adapter-"));
  const seenSignals = [];

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      seenSignals.push(signal);
      if (signal === "SIGTERM") {
        setTimeout(() => child.emit("close", null, signal), 5);
      }
      return true;
    };
    child.stdin = {
      write() {},
      end() {},
    };

    return child;
  };

  const adapter = new CodexExecAdapter({
    spawnImpl,
    timeoutMsByRole: {
      manager: 20,
    },
    killGraceMs: 5,
  });

  const result = await adapter.runTask({
    agentSession: {
      agentId: "agent-timeout-1",
      role: "manager",
      taskId: "task-timeout-1",
      threadId: "",
    },
    envelope: {
      systemPrompt: "System prompt",
      taskPrompt: "Wait forever",
    },
    taskPacket: {
      id: "task-timeout-1",
      title: "Manager bootstrap",
    },
    template: {
      developer_instructions: "Stay strict.",
      sandbox_mode: "read-only",
      model: "gpt-5.4",
      model_reasoning_effort: "xhigh",
      skills: { config: [] },
      mcp_servers: {},
      sandbox_workspace_write: null,
    },
    workspaceRoot,
    runId: "run-timeout-1",
  });

  assert.deepEqual(seenSignals, ["SIGTERM"]);
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /timed out/i);
  assert.equal(result.role, "manager");
});

test("codex exec adapter picks up timeout overrides from environment by default", () => {
  const previous = process.env.LONGRUN_NATIVE_AGENT_TIMEOUT_MANAGER_MS;
  process.env.LONGRUN_NATIVE_AGENT_TIMEOUT_MANAGER_MS = "4321";

  try {
    const adapter = new CodexExecAdapter();
    assert.equal(adapter.timeoutMsByRole.manager, 4321);
  } finally {
    if (previous === undefined) {
      delete process.env.LONGRUN_NATIVE_AGENT_TIMEOUT_MANAGER_MS;
    } else {
      process.env.LONGRUN_NATIVE_AGENT_TIMEOUT_MANAGER_MS = previous;
    }
  }
});

test("codex exec adapter detects inherited MCP servers from a Codex config file", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-codex-adapter-"));
  const configPath = path.join(workspaceRoot, "config.toml");
  await writeFile(configPath, [
    "[mcp_servers.notion]",
    'url = "https://mcp.notion.com/mcp"',
    "",
    "[mcp_servers.github]",
    'command = "github-mcp"',
    "",
  ].join("\n"));

  const adapter = new CodexExecAdapter({
    codexConfigPath: configPath,
  });

  assert.deepEqual(adapter.inheritedMcpServerNames.sort(), ["github", "notion"]);
});

test("child-agent output schema keeps optional role payloads nullable but required", async () => {
  const schemaPath = path.join(process.cwd(), "src/lib/child-agent-output-schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));

  assert.deepEqual([...schema.required].sort(), [
    "status",
    "summary",
    "evidence",
    "filesTouched",
    "questions",
    "review",
    "taskProposals",
    "staffing",
    "verification",
  ].sort());
  assert.ok(schema.properties.taskProposals.items.required.includes("readRoots"));
  assert.deepEqual(schema.properties.verification.type, ["object", "null"]);
  assert.deepEqual(schema.properties.review.type, ["object", "null"]);
});
