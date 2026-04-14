import { randomUUID } from "node:crypto";

import { isoNow } from "./io.js";

export function createQuestion({
  id = randomUUID(),
  taskId,
  question,
  priority = "medium",
  status = "open",
}) {
  if (!String(taskId ?? "").trim()) {
    throw new Error("Question taskId is required.");
  }

  if (!String(question ?? "").trim()) {
    throw new Error("Question text is required.");
  }

  const now = isoNow();

  return {
    id,
    taskId: String(taskId).trim(),
    question: String(question).trim(),
    priority,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

export function answerQuestion(questionRecord, answerId) {
  questionRecord.status = "answered";
  questionRecord.answerId = String(answerId ?? "").trim();
  questionRecord.updatedAt = isoNow();
  return questionRecord;
}

export function hasOpenHighPriorityQuestions(questions = []) {
  return questions.some(
    (question) => question.status !== "answered" && question.priority === "high",
  );
}
