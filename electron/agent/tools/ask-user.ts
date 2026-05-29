// ── ask_user Tool ───────────────────────────────────────────────────────────
//
// Asks the user one or more questions mid-run. The tool's execute() blocks
// on a deferred Promise managed by `electron/agent/questions.ts`; the
// renderer answers via the `questions:reply` IPC handler. Mirrors the
// battle-tested opencode `question` tool pattern.
//
// Use cases the agent reaches for this tool for:
//   - Approval before an irreversible step (start recording, overwrite a demo).
//   - Login / credentials / OTPs / API keys (set `secret: true`).
//   - Disambiguation when the brief is genuinely ambiguous.
//   - Choice between concrete directions.

import { tool } from "ai"
import { z } from "zod"
import { askUser } from "../questions"
import log from "../../lib/logger"

const TOOL_DESCRIPTION = `Ask the user one or more questions during execution and WAIT for their answer. Your turn does NOT end — execute() blocks until the user replies, then continues.

When to use:
1. **Approval** before an irreversible or destructive step (start recording, overwrite an existing demo).
2. **Login or secret credentials** (email/password, API keys, OTPs) when a demo flow needs them. See "Credentials" below for the exact shape — one question per field, ALWAYS.
3. **Disambiguation** when the brief is genuinely ambiguous and the choice meaningfully changes the work.
4. **Choice** between concrete options the user should pick from.

**One call can include 1–4 questions.** Batch related questions together (e.g. email + password) instead of making sequential calls; the UI walks the user through them and returns all answers in one response.

Per-question fields:
- \`question\`: complete sentence ending with "?".
- \`header\`: short chip label (≤30 chars).
- \`options\`: array of \`{ label, description }\`. \`label\` is 1–5 words; \`description\` is one line. Up to 8 options.
- \`multiple\` (default false): allow selecting more than one option.
- \`custom\` (default true): the renderer adds a "type your own answer" input automatically. NEVER add an "Other" or "Custom" option yourself.
- \`secret\` (default false): masks the input and redacts the persisted answer. Use for passwords / API keys / OTPs ONLY — emails and usernames are NOT secrets. For secret-only inputs pass \`options: []\` alongside \`secret: true\`.

Rules:
- Put your recommended option FIRST and append "(Recommended)" to its label.
- Credentials — ONE field per question, ALWAYS. NEVER combine "email and password" into a single question; ask each field as its own question, in the SAME \`ask_user\` call. Email / username → \`secret: false\`, \`options: []\`. Password / API key / OTP → \`secret: true\`, \`options: []\`. Example for a GitHub login: pass TWO questions in one call — { question: "What email should I use to sign in to GitHub?", header: "GitHub email", options: [], secret: false } AND { question: "What password should I use for that GitHub account?", header: "GitHub password", options: [], secret: true }. For 2FA codes, ask AFTER the password is submitted in a SEPARATE \`ask_user\` call once the OTP prompt appears in the browser (codes expire fast).
- Do NOT use this for chit-chat or for things you can decide yourself from context. Save it for blocking decisions and required inputs.`

export interface AskUserToolOptions {
  signal: AbortSignal
}

export function createAskUserTool({ signal }: AskUserToolOptions) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z
              .string()
              .min(1)
              .describe("Complete sentence ending with '?'."),
            header: z
              .string()
              .min(1)
              .max(30)
              .describe("Short chip label (≤30 chars)."),
            options: z
              .array(
                z.object({
                  label: z
                    .string()
                    .min(1)
                    .max(80)
                    .describe("Display text, 1–5 words."),
                  description: z
                    .string()
                    .min(1)
                    .max(300)
                    .describe("One-line explanation of this choice."),
                })
              )
              .max(8)
              .describe(
                "Available choices. Empty array is allowed (e.g. secret-only inputs)."
              ),
            multiple: z
              .boolean()
              .optional()
              .describe("Allow selecting more than one option."),
            custom: z
              .boolean()
              .optional()
              .describe(
                "Allow a free-text 'type your own answer' input (default true)."
              ),
            secret: z
              .boolean()
              .optional()
              .describe(
                "Mask input + redact persisted answer. Use for passwords / API keys / OTPs."
              ),
          })
        )
        .min(1)
        .max(4)
        .describe("Questions to ask (1–4)."),
    }),

    execute: async ({ questions }, { toolCallId }) => {
      try {
        const answers = await askUser({ id: toolCallId, questions }, signal)

        // Build a compact, agent-facing summary string. Secret values flow
        // through verbatim here so the live agent step can act on them
        // (e.g. fill into an agent-browser form). The *persisted* version
        // is redacted in orchestrator.onFinish before write to disk.
        const formatted = questions
          .map((q, i) => {
            const a = answers[i]
            const text = a && a.length ? a.join(", ") : "Unanswered"
            return `"${q.question}"="${text}"`
          })
          .join(", ")

        return {
          ok: true as const,
          answers,
          summary: `User answered: ${formatted}. Continue with these answers in mind.`,
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log.info(`[ask_user] ${toolCallId} unresolved: ${reason}`)
        return {
          ok: false as const,
          reason,
          message:
            reason === "aborted"
              ? "Run was stopped before the user answered."
              : reason === "dismissed"
                ? "User dismissed the question without answering."
                : reason,
          answers: [] as string[][],
        }
      }
    },
  })
}
