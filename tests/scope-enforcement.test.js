import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController } from "../src/lib/controller.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class ScopeRuntimeAdapter {
  constructor(filesTouched = []) {
    this.filesTouched = filesTouched;
  }

  async runTask({ agentSession, taskPacket }) {
    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: agentSession.role === "executor" ? [`self-test:${taskPacket.id}`] : [],
      filesTouched: this.filesTouched,
      questions: [],
    };
  }
}

test("controller rejects multiple write-capable executors in the same dispatch batch", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-scope-"));
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-scope-1",
    missionDigest: "digest-scope",
    runtime: new NativeAgentRuntime({
      adapter: new ScopeRuntimeAdapter(),
    }),
  });

  await assert.rejects(
    () =>
      controller.dispatchAssignments([
        {
          role: "executor",
          taskPacket: { id: "task-1", title: "Exec 1", allowedFiles: ["src/lib/a.js"] },
        },
        {
          role: "executor",
          taskPacket: { id: "task-2", title: "Exec 2", allowedFiles: ["src/lib/b.js"] },
        },
      ]),
    /Single-writer rule violation/,
  );
});

test("controller rejects touched files outside the allowed scope", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-scope-"));
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-scope-2",
    missionDigest: "digest-scope",
    runtime: new NativeAgentRuntime({
      adapter: new ScopeRuntimeAdapter(["src/lib/not-allowed.js"]),
    }),
  });

  await assert.rejects(
    () =>
      controller.dispatchAssignments([
        {
          role: "executor",
          taskPacket: {
            id: "task-1",
            title: "Scoped executor",
            allowedFiles: ["src/lib/controller.js"],
            forbiddenFiles: ["README.md"],
          },
        },
      ]),
    /Touched file outside allowed scope/,
  );
});
