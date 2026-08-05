// ── Media duration probe ─────────────────────────────────────────────────────
//
// `ffmpeg -i` prints "Duration: HH:MM:SS.cc" to stderr and exits non-zero
// without an output file — capture stderr regardless of exit code. Shared by
// the scene verifier and the sync renderer.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveFfmpeg } from "../../lib/ffmpeg"

const execFileAsync = promisify(execFile)

export async function probeDurationSec(videoPath: string): Promise<number> {
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
