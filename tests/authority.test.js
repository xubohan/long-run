import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthorityPromptSection,
  resolveAuthorityConflict,
} from "../src/lib/authority.js";

test("authority conflicts escalate when lower precedence tries to override higher precedence", () => {
  const result = resolveAuthorityConflict({
    attemptedSource: "manager_task_contract",
    conflictingSource: "project_rules",
  });

  assert.equal(result.decision, "escalate");
  assert.match(result.reason, /cannot override higher-precedence project_rules/);
});

test("authority prompt section renders the fixed precedence order", () => {
  const section = buildAuthorityPromptSection();

  assert.match(section, /1\. Project rules/);
  assert.match(section, /2\. User task instructions/);
  assert.match(section, /3\. Child role prompt \/ role semantics/);
  assert.match(section, /4\. Manager task contract/);
});
