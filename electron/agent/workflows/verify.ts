// ── Scene mechanical verifier (ADR-004 Layer 1) ─────────────────────────────

import { promises as fs } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { resolveFfmpeg } from "../../lib/ffmpeg"
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
const execFileAsync = promisify(execFile)

export interface VerifyInput {
  scene: Scene
  videoPath: string
  actionsPath: string
  finalUrl: string
}

async function probeDurationSec(videoPath: string): Promise<number> {
  // ffmpeg -i prints "Duration: HH:MM:SS.cc" to stderr and exits non-zero
  // without an output file — capture stderr regardless of exit code.
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) throw new Error("no ffmpeg binary available to probe duration")
  let stderr = ""
  try {
    const r = await execFileAsync(ffmpeg, ["-i", videoPath], { encoding: "utf8" })
    stderr = r.stderr
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ""
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) throw new Error(`could not read duration from ${videoPath}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
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
      const dur = pure.checkDurationRange(durationSec, input.scene)
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
