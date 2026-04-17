// ── Title Generator ──────────────────────────────────────────────────────────
//
// Parses a user's opening prompt into a product domain + short project / thread
// titles. Uses `generateObject` with a small Zod schema. Intended to run in
// parallel with the main agent run — failures must not block the chat.

import { generateObject } from "ai"
import { z } from "zod"
import log from "../lib/logger"
import { getModel } from "./providers"

const TitleSchema = z.object({
  domain: z
    .string()
    .nullable()
    .describe(
      "The product domain (e.g. 'cal.com', 'linear.app'). Null if the prompt mentions no product."
    ),
  projectTitle: z
    .string()
    .describe("Short (≤40 chars) project title summarising the product."),
  threadTitle: z
    .string()
    .describe("Short (≤40 chars) thread title summarising the specific demo."),
})

export type GeneratedTitles = z.infer<typeof TitleSchema>

const SYSTEM = `You name demo-video projects. Given a user prompt describing what they want to demo, return:
- domain: the product domain if mentioned (e.g. "cal.com"), else null
- projectTitle: short label for the product (e.g. "Cal.com")
- threadTitle: short label for the specific demo flow (e.g. "Event type setup")
Keep each under 40 characters. No trailing punctuation.`

function fallback(text: string): GeneratedTitles {
  const firstWords = text.split(/\s+/).slice(0, 6).join(" ")
  return {
    domain: null,
    projectTitle: firstWords || "Untitled project",
    threadTitle: "Chat",
  }
}

export async function generateProjectTitles(
  text: string,
  modelId: string
): Promise<GeneratedTitles> {
  try {
    const model = getModel(modelId)
    const { object } = await generateObject({
      model,
      schema: TitleSchema,
      system: SYSTEM,
      prompt: text,
    })
    return object
  } catch (err) {
    log.error("[title-generator] failed:", err)
    return fallback(text)
  }
}
