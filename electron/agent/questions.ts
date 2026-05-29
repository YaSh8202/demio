// ── Pending Question Registry ────────────────────────────────────────────────
//
// Singleton store of in-flight `ask_user` tool calls. The tool's execute()
// registers a deferred via `askUser()` and awaits the returned Promise. The
// renderer answers via the `questions:reply` IPC handler (which calls
// `replyToQuestion`), resolving the deferred and unblocking the tool.
//
// Mirrors opencode's `Question.Service` but plain TypeScript — no Effect.
//
// Keyed by `toolCallId` so the renderer's UI (which sees the streamed tool
// part with the same id) can correlate without a separate question id.

import log from "../lib/logger"

export interface AskQuestionOption {
  /** Display text (1–5 words, concise). */
  label: string
  /** One-line explanation of the choice. */
  description: string
}

export interface AskQuestionInfo {
  /** Full prompt sentence, ending with "?". */
  question: string
  /** Short chip label (≤30 chars). */
  header: string
  /** Available choices. Empty array is valid (e.g. secret-only inputs). */
  options: AskQuestionOption[]
  /** Allow selecting more than one option. */
  multiple?: boolean
  /** Allow typing a free-text answer (default true). */
  custom?: boolean
  /** Mask input + redact persisted answer. Use for passwords / API keys / OTPs. */
  secret?: boolean
}

export interface AskRequest {
  /** Equals the tool call id — used by the renderer to correlate. */
  id: string
  questions: AskQuestionInfo[]
}

/** Selected labels (or [customText]) for a single question. */
export type AskAnswer = string[]

interface Pending {
  request: AskRequest
  resolve: (answers: AskAnswer[]) => void
  reject: () => void
}

const pending = new Map<string, Pending>()
const askedSubscribers = new Set<(req: AskRequest) => void>()
const resolvedSubscribers = new Set<(id: string) => void>()

/**
 * Register a question and await the user's answer.
 *
 * Resolves with one `AskAnswer` per question, in order. Rejects with
 * `"aborted"` when the agent's AbortSignal fires or `"dismissed"` when
 * the user dismisses the question.
 */
export function askUser(
  req: AskRequest,
  signal?: AbortSignal
): Promise<AskAnswer[]> {
  if (pending.has(req.id)) {
    // Defensive: re-registering the same id would orphan the previous
    // promise. Reject the old one so the agent's prior execute() unwinds.
    rejectQuestion(req.id)
  }

  return new Promise<AskAnswer[]>((resolve, reject) => {
    const entry: Pending = {
      request: req,
      resolve,
      reject: () => reject(new Error("dismissed")),
    }
    pending.set(req.id, entry)
    log.info(`[questions] asking ${req.id} (${req.questions.length} question${req.questions.length === 1 ? "" : "s"})`)

    askedSubscribers.forEach((cb) => {
      try {
        cb(req)
      } catch (err) {
        log.error("[questions] asked subscriber threw:", err)
      }
    })

    if (signal) {
      const onAbort = () => {
        const existing = pending.get(req.id)
        if (!existing) return
        pending.delete(req.id)
        log.info(`[questions] aborted ${req.id}`)
        reject(new Error("aborted"))
        resolvedSubscribers.forEach((cb) => {
          try {
            cb(req.id)
          } catch (err) {
            log.error("[questions] resolved subscriber threw:", err)
          }
        })
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }
  })
}

/** Snapshot of all questions currently awaiting an answer. */
export function listPending(): AskRequest[] {
  return Array.from(pending.values(), (p) => p.request)
}

export function replyToQuestion(id: string, answers: AskAnswer[]): void {
  const existing = pending.get(id)
  if (!existing) {
    log.warn(`[questions] reply for unknown id ${id}`)
    return
  }
  pending.delete(id)
  log.info(`[questions] replied ${id}`)
  existing.resolve(answers)
  resolvedSubscribers.forEach((cb) => {
    try {
      cb(id)
    } catch (err) {
      log.error("[questions] resolved subscriber threw:", err)
    }
  })
}

export function rejectQuestion(id: string): void {
  const existing = pending.get(id)
  if (!existing) {
    log.warn(`[questions] reject for unknown id ${id}`)
    return
  }
  pending.delete(id)
  log.info(`[questions] rejected ${id}`)
  existing.reject()
  resolvedSubscribers.forEach((cb) => {
    try {
      cb(id)
    } catch (err) {
      log.error("[questions] resolved subscriber threw:", err)
    }
  })
}

/** Subscribe to new `ask_user` requests. Returns an unsubscribe fn. */
export function onAsked(cb: (req: AskRequest) => void): () => void {
  askedSubscribers.add(cb)
  return () => askedSubscribers.delete(cb)
}

/** Subscribe to reply/reject/abort lifecycle. Returns an unsubscribe fn. */
export function onResolved(cb: (id: string) => void): () => void {
  resolvedSubscribers.add(cb)
  return () => resolvedSubscribers.delete(cb)
}
