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

test("child-agent output schema keeps optional role payloads nullable but required", async () => {
  const schemaPath = path.join(process.cwd(), "src/lib/child-agent-output-schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));

  assert.deepEqual(schema.required, [
    "status",
    "summary",
    "evidence",
    "filesTouched",
    "questions",
    "verification",
    "review",
  ]);
  assert.deepEqual(schema.properties.verification.type, ["object", "null"]);
  assert.deepEqual(schema.properties.review.type, ["object", "null"]);
});
