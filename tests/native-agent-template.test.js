import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLongRunAgentTemplate,
  createLongRunTemplateLayer,
  getCodexExecTemplateSupportMatrix,
  materializeLongRunTemplateLayer,
  renderAgentTemplateToml,
} from "../src/lib/native-agent-template.js";

test("support matrix reflects native vs protocol capabilities", () => {
  const matrix = getCodexExecTemplateSupportMatrix();

  assert.equal(matrix.customAgentFile.level, "direct");
  assert.equal(matrix.mcpToolAllowDeny.level, "direct");
  assert.equal(matrix.readScope.level, "partial");
  assert.equal(matrix.directPeerChat.level, "none");
  assert.equal(matrix.controllerRelay.level, "indirect");
});

test("executor template keeps write scope in sandbox roots and relay protocol in instructions", () => {
  const template = buildLongRunAgentTemplate({
    role: "executor",
    readRoots: ["src", "tests"],
    writeRoots: ["src", "tests", ".longrun"],
    skills: [{ path: ".codex/skills/longrun-agent-protocol", enabled: true }],
    mcpServers: {
      notion: {
        enabled: true,
        enabledTools: ["fetch", "search"],
        disabledTools: ["update_page"],
      },
    },
    communication: {
      mode: "controller-relay",
      questionPath: ".longrun/runs/<run-id>/questions/",
      answerPath: ".longrun/runs/<run-id>/answers/",
      resultPath: ".longrun/runs/<run-id>/artifacts/",
    },
  });

  assert.equal(template.sandbox_mode, "workspace-write");
  assert.deepEqual(template.sandbox_workspace_write, {
    writable_roots: ["src", "tests", ".longrun"],
  });
  assert.match(template.developer_instructions, /controller-relay/);
  assert.match(template.developer_instructions, /read focus roots: src, tests/);
  assert.match(template.developer_instructions, /Structured output rules:/);
  assert.match(template.developer_instructions, /taskProposals, staffing, verification, and review/);
  assert.match(template.developer_instructions, /Use \[\] for questions, taskProposals, or staffing/);
  assert.deepEqual(template.mcp_servers.notion.enabled_tools, ["fetch", "search"]);
});

test("rendered TOML includes writable roots, skills config, and MCP tool allow lists", () => {
  const template = buildLongRunAgentTemplate({
    role: "executor",
    writeRoots: ["src", ".longrun"],
    skills: [{ path: ".codex/skills/longrun-agent-protocol", enabled: true }],
    mcpServers: {
      docs: {
        url: "https://developers.openai.com/mcp",
        enabledTools: ["search", "fetch"],
      },
    },
  });

  const toml = renderAgentTemplateToml(template);

  assert.match(toml, /name = "longrun_executor"/);
  assert.match(toml, /sandbox_mode = "workspace-write"/);
  assert.match(toml, /\[sandbox_workspace_write\]/);
  assert.match(toml, /writable_roots = \["src", ".longrun"\]/);
  assert.match(toml, /\[\[skills\.config\]\]/);
  assert.match(toml, /path = ".codex\/skills\/longrun-agent-protocol"/);
  assert.match(toml, /\[mcp_servers\.docs\]/);
  assert.match(toml, /enabled_tools = \["search", "fetch"\]/);
});

test("template layer builds the six baseline long-run roles", () => {
  const layer = createLongRunTemplateLayer({
    readRoots: ["src", "tests", "docs"],
    writeRootsByRole: {
      executor: ["src", "tests", ".longrun"],
    },
  });

  assert.deepEqual(Object.keys(layer.templates), [
    "manager",
    "planner",
    "observer",
    "executor",
    "verifier",
    "reviewer",
  ]);
  assert.equal(layer.templates.manager.sandbox_mode, "read-only");
  assert.equal(layer.templates.executor.sandbox_mode, "workspace-write");
  assert.match(layer.templates.manager.developer_instructions, /Clarify key ambiguities before dispatching child work/);
});

test("materializer writes project-scoped custom agent toml files", () => {
  const targetDir = mkdtempSync(join(tmpdir(), "longrun-agent-layer-"));
  const layer = materializeLongRunTemplateLayer({
    targetDir,
    readRoots: ["src", "tests"],
    writeRootsByRole: {
      executor: ["src", ".longrun"],
    },
  });

  assert.ok(layer.files.manager.endsWith("longrun_manager.toml"));
  assert.ok(layer.files.executor.endsWith("longrun_executor.toml"));

  const executorToml = readFileSync(layer.files.executor, "utf8");
  assert.match(executorToml, /sandbox_mode = "workspace-write"/);
  assert.match(executorToml, /writable_roots = \["src", ".longrun"\]/);
});
