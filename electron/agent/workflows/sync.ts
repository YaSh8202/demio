// ── Sync/retiming renderer (Milestone 2) ─────────────────────────────────────
//
// Executes a scene's EDL as a staged ffmpeg pipeline — every intermediate
// lands on disk so a bad cut is diagnosable by inspecting files:
//
//   scenes/<id>.slots/slot-NN.mp4   (trim + freeze-hold, silent h264)
//   scenes/<id>.retimed.mp4         (slot concat, -c copy, video-only)
//   scenes/<id>.final.mp4           (voice mix OR silent track, uniform a/v)
//   scenes/<id>.edl.json            (persisted EDL — future re-render/edit)
//
// EDL math lives in edl-pure.cjs (unit-tested, no I/O). Failures here are
// deterministic code bugs, not agent flakiness — this module hard-throws and
// leaves artifacts in place; it never suspends or degrades to the raw video.

import { promises as fs } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { resolveFfmpeg } from "../../lib/ffmpeg"
import { probeDurationSec } from "../lib/media-probe"

const require = createRequire(import.meta.url)

export interface ActionEntry {
  idx: number
  tsMs: number
  durationMs: number
  action: string
  argsSummary: string
}

export type SegmentAnchor = "intro" | "outro" | number

export interface EdlSlot {
  kind: "intro" | "action" | "outro"
  srcStartMs: number
  srcEndMs: number
  holdMs: number
  outStartMs: number
  outEndMs: number
  actionIdxs: number[]
  segmentIdxs: number[]
}

export interface Edl {
  version: 1
  videoDurationMs: number
  opts: Record<string, number>
  slots: EdlSlot[]
  segments: Array<{ idx: number; anchor: SegmentAnchor; durationMs: number; outStartMs: number }>
  totalMs: number
}

const pure = require("./edl-pure.cjs") as {
  EDL_DEFAULTS: Record<string, number>
  parseActionEntries: (jsonl: string) => ActionEntry[]
  buildEdl: (input: {
    actionEntries: ActionEntry[]
    videoDurationMs: number
    segments: Array<{ anchor: SegmentAnchor; durationMs: number }>
    opts?: Record<string, number>
  }) => Edl
  validateEdl: (edl: Edl, videoDurationMs: number) => { ok: boolean; errors: string[] }
  buildSlotArgs: (sourcePath: string, slot: EdlSlot, outPath: string) => string[]
  buildConcatListText: (paths: string[]) => string
  buildMixArgs: (
    retimedPath: string,
    segments: Array<{ file: string; outStartMs: number }>,
    outputPath: string
  ) => string[]
  buildSilentAudioArgs: (retimedPath: string, outputPath: string) => string[]
}

export const parseActionEntries = pure.parseActionEntries

const execFileAsync = promisify(execFile)

export interface RenderSceneOpts {
  workspace: string
  sceneId: string
  /** Absolute path to the raw scene capture (.webm). */
  videoPath: string
  /** Absolute path to the scene's actions.jsonl. */
  actionsPath: string
  /** Playback-ordered synthesized segments; `file` is workspace-relative. */
  segments: Array<{ text: string; anchor: SegmentAnchor; file: string; durationMs: number }>
}

export async function renderScene(opts: RenderSceneOpts): Promise<{
  finalPath: string
  edlPath: string
  totalMs: number
}> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) throw new Error("ffmpeg binary not available — cannot retime scene")

  const jsonl = await fs.readFile(opts.actionsPath, "utf8")
  const actionEntries = pure.parseActionEntries(jsonl)
  const videoDurationMs = Math.round((await probeDurationSec(opts.videoPath)) * 1000)

  const edl = pure.buildEdl({
    actionEntries,
    videoDurationMs,
    segments: opts.segments.map((s) => ({ anchor: s.anchor, durationMs: s.durationMs })),
  })
  const validation = pure.validateEdl(edl, videoDurationMs)
  if (!validation.ok) {
    throw new Error(
      `sync: invalid EDL for ${opts.sceneId}: ${validation.errors.join("; ")}`
    )
  }

  // Persist the EDL (with text/file enrichment) BEFORE rendering so a
  // render failure still leaves the plan on disk for diagnosis.
  const edlPath = path.join(opts.workspace, "scenes", `${opts.sceneId}.edl.json`)
  await fs.writeFile(
    edlPath,
    JSON.stringify(
      {
        ...edl,
        source: path.relative(opts.workspace, opts.videoPath),
        segments: edl.segments.map((s) => ({
          ...s,
          text: opts.segments[s.idx]?.text,
          file: opts.segments[s.idx]?.file,
        })),
      },
      null,
      2
    )
  )

  // Stage 1: trim each slot (+freeze hold) to its own silent h264 clip.
  const slotsDir = path.join(opts.workspace, "scenes", `${opts.sceneId}.slots`)
  await fs.mkdir(slotsDir, { recursive: true })
  const slotPaths: string[] = []
  for (let i = 0; i < edl.slots.length; i++) {
    const slotPath = path.join(slotsDir, `slot-${String(i).padStart(2, "0")}.mp4`)
    await execFileAsync(ffmpeg, pure.buildSlotArgs(opts.videoPath, edl.slots[i], slotPath))
    slotPaths.push(slotPath)
  }

  // Stage 2: concat slots (identical encode params → stream copy).
  const listPath = path.join(slotsDir, "concat.txt")
  await fs.writeFile(listPath, pure.buildConcatListText(slotPaths))
  const retimedPath = path.join(opts.workspace, "scenes", `${opts.sceneId}.retimed.mp4`)
  await execFileAsync(ffmpeg, [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", retimedPath,
  ])

  // Stage 3: audio — voice mix at EDL offsets, or a silent track. Either
  // way the output has one video + one 44100/stereo aac stream so the
  // final demo concat can stream-copy.
  const finalPath = path.join(opts.workspace, "scenes", `${opts.sceneId}.final.mp4`)
  if (opts.segments.length > 0) {
    const mixSegments = edl.segments.map((s) => ({
      file: opts.segments[s.idx].file,
      outStartMs: s.outStartMs,
    }))
    await execFileAsync(ffmpeg, pure.buildMixArgs(retimedPath, mixSegments, finalPath), {
      cwd: opts.workspace,
    })
  } else {
    await execFileAsync(ffmpeg, pure.buildSilentAudioArgs(retimedPath, finalPath))
  }

  // Post-render check: rendered duration must match the EDL's arithmetic.
  // A drift beyond tolerance means a builder/renderer bug — fail loudly.
  const renderedMs = Math.round((await probeDurationSec(finalPath)) * 1000)
  if (Math.abs(renderedMs - edl.totalMs) > 1000) {
    throw new Error(
      `sync: rendered ${opts.sceneId} is ${renderedMs}ms but EDL computed ${edl.totalMs}ms ` +
        `(>1s drift) — inspect ${slotsDir} and ${edlPath}`
    )
  }

  return { finalPath, edlPath, totalMs: edl.totalMs }
}
