// ── Workflow Progress Card ──────────────────────────────────────────────────
//
// Stage tracker for the `generate_demo` tool call (Task 12's demo-video
// workflow: record every scene -> narrate -> tts -> compose). Renders in
// place of `tool-usage.tsx`'s generic `<Tool>` card whenever a message part's
// tool name is `generate_demo` — wired in from `tool-usage.tsx`'s
// `ThreadToolUsage`.
//
// Per-scene rows come from this call's entry in `useAgentEvents`'s
// `workflows` map (`src/hooks/use-agent-events.ts`, keyed by `toolCallId`),
// folded from BOTH carriers of `scene-progress`: live `tool_update` events,
// and the `data-mastracode-tool-progress` parts persisted on the assistant
// message — the latter is what keeps a refreshed thread showing real phases
// instead of resetting every row to "Queued".
//
// Scene ORDER and TITLE are not part of that slice (the harness only
// reports progress for scenes it has started) — they come from the tool
// call's own `input.plan.scenes`, which is available the instant the tool
// call is made (before any progress event arrives), so a freshly-started run
// shows every scene as "Queued" immediately instead of an empty card.
//
// LIMITATION (documented in the brief, called out again here + in the task
// report): narrate/tts/compose — the three workflow steps AFTER every scene
// finishes recording — have no progress events of their own (Task 12 only
// wired `writer.write` inside `record-scene`'s per-attempt loop). This card
// cannot distinguish "narrating" from "synthesizing voiceover" from
// "composing with ffmpeg" — once every scene reports `done` and the tool
// call itself hasn't resolved yet, the footer collapses all three into one
// generic "Finalizing…" state. A future task wiring `writer.write` calls
// into `narrateStep`/`ttsStep`/`composeStep` (demo-video.ts) could split
// this into real per-stage rows without touching this component's shape —
// only the footer's render branch below.

import { CheckIcon, CircleIcon, XCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type {
  WorkflowSceneState,
  WorkflowState,
} from "@/hooks/use-agent-events"
import type { DynamicToolUIPart } from "ai"

/** The slice of `generate_demo`'s `{plan: ScenePlan}` input this card needs —
 * see `electron/agent/workflows/schemas.ts`'s `scenePlanSchema`. */
interface GenerateDemoInput {
  plan?: {
    demoTitle?: string
    scenes?: { id: string; title?: string }[]
  }
}

interface WorkflowProgressOutput {
  videoPath?: string
}

interface WorkflowProgressProps {
  toolState: DynamicToolUIPart["state"]
  input: unknown
  output: unknown
  errorText?: string
  /** This tool call's own entry from `useAgentEvents().workflows` (looked up
   * by `toolCallId` in `tool-usage.tsx`) — `null` until the first
   * `scene-progress` for this call, from either carrier: a live `tool_update`
   * event, or a persisted `data-mastracode-tool-progress` message part
   * replayed on hydration. Because the map is keyed by `toolCallId`, an
   * older `generate_demo` call's state can never bleed into this card. */
  workflow: WorkflowState | null
}

function asGenerateDemoInput(value: unknown): GenerateDemoInput {
  return typeof value === "object" && value !== null
    ? (value as GenerateDemoInput)
    : {}
}

function asOutput(value: unknown): WorkflowProgressOutput {
  return typeof value === "object" && value !== null
    ? (value as WorkflowProgressOutput)
    : {}
}

const PHASE_LABEL: Record<WorkflowSceneState["phase"], string> = {
  recording: "Recording",
  verifying: "Verifying",
  failed: "Failed",
  done: "Done",
}

function SceneStatusIcon({
  phase,
}: {
  phase: WorkflowSceneState["phase"] | "queued"
}) {
  if (phase === "done") {
    return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
  }
  if (phase === "failed") {
    return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
  }
  if (phase === "recording" || phase === "verifying") {
    return (
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className="pulse-dot size-1.5 rounded-full bg-amber-400" />
      </span>
    )
  }
  return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
}

function SceneRow({
  sceneId,
  title,
  state,
}: {
  sceneId: string
  title?: string
  state: WorkflowSceneState | undefined
}) {
  const phase = state?.phase ?? "queued"
  const label = state ? PHASE_LABEL[state.phase] : "Queued"

  return (
    <div className="flex items-start gap-2 py-1">
      <SceneStatusIcon phase={phase} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] leading-5 font-medium text-foreground">
            {title ?? sceneId}
          </span>
          <span className="text-[12px] leading-5 text-muted-foreground">
            {label}
          </span>
          {state && state.attempt > 1 && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              attempt {state.attempt}
            </Badge>
          )}
        </div>
        {phase === "failed" && state?.detail && (
          <p className="mt-0.5 text-[11px] leading-4 break-words text-destructive">
            {state.detail}
          </p>
        )}
      </div>
    </div>
  )
}

export function WorkflowProgress({
  toolState,
  input,
  output,
  errorText,
  workflow,
}: WorkflowProgressProps) {
  const plan = asGenerateDemoInput(input).plan
  const planScenes = plan?.scenes ?? []
  const liveScenes = workflow?.scenes ?? {}

  // A resumed/reloaded thread may report scene progress for ids that never
  // appeared in `plan.scenes` here (e.g. `input` hasn't hydrated yet on a
  // fast first render) — fall back to whatever `liveScenes` has, in
  // insertion order, so the card never silently drops a scene.
  const sceneIds =
    planScenes.length > 0
      ? planScenes.map((s) => s.id)
      : Object.keys(liveScenes)

  const sceneTitleById = new Map(planScenes.map((s) => [s.id, s.title]))

  const isToolDone = toolState === "output-available"
  const isToolErrored = toolState === "output-error"
  const allScenesDone =
    sceneIds.length > 0 &&
    sceneIds.every((id) => liveScenes[id]?.phase === "done")

  const videoPath = asOutput(output).videoPath

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <div className="border-b border-border/50 px-3 py-1.5">
        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
          {plan?.demoTitle || "Demo generation"}
        </p>
      </div>

      <div className="divide-y divide-border/30 px-3">
        {sceneIds.map((id) => (
          <SceneRow
            key={id}
            sceneId={id}
            title={sceneTitleById.get(id)}
            state={liveScenes[id]}
          />
        ))}
      </div>

      {/* Post-recording stages — see file header for why this collapses
          narrate/tts/compose into one row instead of three. */}
      <div
        className={cn(
          "flex items-center gap-2 border-t border-border/50 px-3 py-1.5 text-[12px] leading-5",
          isToolErrored
            ? "text-destructive"
            : isToolDone
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
        )}
      >
        {isToolErrored ? (
          <>
            <XCircleIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              {errorText || "Demo generation failed."}
            </span>
          </>
        ) : isToolDone ? (
          <>
            <CheckIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Video ready{videoPath ? ` — ${videoPath}` : ""}
            </span>
          </>
        ) : allScenesDone ? (
          <>
            <span className="pulse-dot size-1.5 shrink-0 rounded-full bg-amber-400" />
            <span>Finalizing — narrating, voicing, and composing…</span>
          </>
        ) : (
          <span>Narrate → voice → compose run after every scene is done.</span>
        )}
      </div>
    </div>
  )
}
