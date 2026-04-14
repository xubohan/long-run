import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { fileURLToPath } from "node:url";

import { LongRunController } from "../src/lib/controller.js";

const execFile = promisify(execFileCb);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("cli routes v2 runs by engine and exposes the clarification answer path", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-cli-v2-"));

  const started = await execFile("node", [
    cliPath,
    "start",
    "--engine",
    "v2",
    "--goal",
    "Route CLI commands by immutable engine",
    "--done",
    "CLI respects v2 routing.",
  ], {
    cwd: workspaceRoot,
  });

  assert.match(started.stdout, /engine: v2/);
  const runId = started.stdout.match(/run_id: (.+)/)?.[1]?.trim();
  assert.ok(runId);

  const status = await execFile("node", [cliPath, "status", runId], {
    cwd: workspaceRoot,
  });
  assert.match(status.stdout, /engine: v2/);

  const controller = new LongRunController({
    workspaceRoot,
    runId,
    missionDigest: "",
  });
  const clarification = await controller.requestClarification("Which engine should the CLI report?");

  const answered = await execFile("node", [
    cliPath,
    "answer",
    runId,
    "--clarification-id",
    clarification.id,
    "--answer",
    "The CLI should report the immutable v2 engine.",
  ], {
    cwd: workspaceRoot,
  });

  assert.match(answered.stdout, /engine: v2/);
  assert.match(answered.stdout, /status: ready/);
});

test("cli help exposes auto-bootstrap for approve and answer on v2 flows", async () => {
  const help = await execFile("node", [cliPath, "--help"]);

  assert.match(help.stdout, /approve .*--auto-bootstrap/);
  assert.match(help.stdout, /answer .*--auto-bootstrap/);
});
