// ── Scene mechanical verifier (ADR-004 Layer 1) ─────────────────────────────

import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { probeDurationSec } from "../lib/media-probe"
import type { Scene, VerifyReport } from "./schemas"

const require = createRequire(import.meta.url)
const pure = require("./verify-pure.cjs") as {
  parseActionsLog: (jsonl: string) => {
    total: number
    failed: Array<{ line: number; action: string; error: string }>
  }
  checkDurationRange: (
    d: number,
    s: Pick<Scene, "minDurationSec" | "maxDurationSec">
  ) => { ok: boolean; detail: string }
  checkEndUrl: (u: string, s: Pick<Scene, "endUrl">) => { ok: boolean; detail: string }
}

export interface VerifyInput {
  scene: Scene
  videoPath: string
  actionsPath: string
  finalUrl: string
}

export async function verifyScene(input: VerifyInput): Promise<VerifyReport> {
  const checks: VerifyReport["checks"] = []

  let exists = false
  try {
    const stat = await fs.stat(input.videoPath)
    exists = stat.size > 0
  } catch {
    exists = false
  }
  checks.push({
    name: "video-exists",
    ok: exists,
    detail: exists ? input.videoPath : `missing or empty: ${input.videoPath}`,
  })

  if (exists) {
    try {
      const durationSec = await probeDurationSec(input.videoPath)
      // Planner-authored bounds imagine final-video pacing, but the raw
      // recording includes the recorder agent's LLM think-time between
      // actions — routinely 5-10x the imagined length. The mechanical
      // check's job is catching broken recordings, not pacing, so the max
      // is clamped up to a generous floor; a genuinely runaway recording
      // still fails. (Seen live: planner set [3, 6], real scene was 30.6s.)
      const dur = pure.checkDurationRange(durationSec, {
        minDurationSec: input.scene.minDurationSec,
        maxDurationSec: Math.max(input.scene.maxDurationSec, 120),
      })
      checks.push({ name: "duration-range", ok: dur.ok, detail: dur.detail })
    } catch (err) {
      checks.push({
        name: "duration-range",
        ok: false,
        detail: `could not probe duration: ${(err as Error).message}`,
      })
    }
  } else {
    checks.push({ name: "duration-range", ok: false, detail: "skipped: no video" })
  }

  let actionsDetail = ""
  let actionsOk = false
  try {
    const jsonl = await fs.readFile(input.actionsPath, "utf8")
    const parsed = pure.parseActionsLog(jsonl)
    actionsOk = parsed.total > 0 && parsed.failed.length === 0
    actionsDetail = actionsOk
      ? `${parsed.total} actions ok`
      : parsed.total === 0
        ? "actions log is empty"
        : parsed.failed
            .map((f) => `line ${f.line}: ${f.action} — ${f.error}`)
            .join("; ")
  } catch {
    actionsDetail = `missing actions log: ${input.actionsPath}`
  }
  checks.push({ name: "actions-ok", ok: actionsOk, detail: actionsDetail })

  const url = pure.checkEndUrl(input.finalUrl, input.scene)
  checks.push({ name: "end-url", ok: url.ok, detail: url.detail })

  return { ok: checks.every((c) => c.ok), checks }
}
