// ── Questions IPC Handlers ──────────────────────────────────────────────────
//
// Namespace: "questions"
// Renderer-facing API for the `ask_user` agent tool. The agent registers a
// pending question (via the questions registry); the renderer lists/answers
// it through these handlers.

import type { NamespaceHandlers } from "../constants"
import {
  listPending,
  replyToQuestion,
  rejectQuestion,
  type AskRequest,
  type AskAnswer,
} from "../agent/questions"

export const questionsHandlers = {
  /** Snapshot of all questions currently awaiting an answer. */
  list: (_event: Electron.IpcMainInvokeEvent): AskRequest[] => {
    return listPending()
  },

  /** Resolve a pending question. `answers[i]` is the array of selected labels for question i. */
  reply: (
    _event: Electron.IpcMainInvokeEvent,
    id: string,
    answers: AskAnswer[]
  ): { ok: true } => {
    replyToQuestion(id, answers)
    return { ok: true }
  },

  /** Dismiss a pending question (user pressed Esc). */
  reject: (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): { ok: true } => {
    rejectQuestion(id)
    return { ok: true }
  },
} satisfies NamespaceHandlers
