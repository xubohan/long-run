import { randomUUID } from "node:crypto";

import { isoNow } from "./io.js";

export function createClarification({
  id = randomUUID(),
  prompt,
  status = "open",
  answer = "",
}) {
  if (!String(prompt ?? "").trim()) {
    throw new Error("Clarification prompt is required.");
  }

  const now = isoNow();

  return {
    id,
    prompt: String(prompt).trim(),
    status,
    answer: String(answer ?? "").trim(),
    createdAt: now,
    updatedAt: now,
  };
}

export function answerClarification(clarification, answer) {
  clarification.answer = String(answer ?? "").trim();
  clarification.status = "answered";
  clarification.updatedAt = isoNow();
  return clarification;
}

export function hasOpenClarifications(clarifications = []) {
  return clarifications.some((clarification) => clarification.status !== "answered");
}
