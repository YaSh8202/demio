import type { UIMessage } from "ai"

type ThreadMessagePart = UIMessage["parts"][number]

interface PresentedFileLike {
  kind?: string
  absPath?: string
}

interface PresentFilesOutputLike {
  files?: PresentedFileLike[]
}

/** `generate_demo`'s output — see `workflow-progress.tsx`. */
interface GenerateDemoOutputLike {
  videoPath?: string
}

function toolNameOf(part: ThreadMessagePart): string | null {
  if (part.type === "dynamic-tool") {
    return (part as { toolName?: string }).toolName ?? null
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.split("-").slice(1).join("-")
  }
  return null
}

export interface PresentedVideo {
  path: string
  /**
   * Identifies the tool call that produced it. Regenerating writes to the
   * same path, so the path alone can't tell you the bytes changed — but a
   * regeneration is always a new tool call.
   */
  key: string
}

/**
 * Find the most recent video in a thread.
 *
 * Two different tools can produce one, and a thread may use either:
 *   - `present_files` — the agent explicitly showing output files.
 *   - `generate_demo` — the orchestrator workflow, whose output carries
 *     `videoPath` directly (this is what renders the "Video ready — …"
 *     footer on the workflow card).
 *
 * This reads the message data rather than relying on the chat UI to tell us.
 * Both tools render inside a collapsed `Collapsible`, and Radix unmounts
 * collapsed content — so a callback fired from a rendered component's effect
 * never runs until the user manually expands that block, leaving the video
 * panel empty even though the file exists.
 */
export function findLatestVideo(messages: UIMessage[]): PresentedVideo | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m]?.parts
    if (!parts) continue
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]
      const tool = toolNameOf(part)
      if (tool !== "present_files" && tool !== "generate_demo") continue
      if ((part as { state?: string }).state !== "output-available") continue

      const output = (part as { output?: unknown }).output as
        | (PresentFilesOutputLike & GenerateDemoOutputLike)
        | undefined
      if (!output) continue

      const path =
        tool === "generate_demo"
          ? output.videoPath
          : output.files?.find((file) => file.kind === "video" && file.absPath)
              ?.absPath

      if (path) {
        const callId = (part as { toolCallId?: string }).toolCallId
        return { path, key: callId ?? `${m}:${p}` }
      }
    }
  }
  return null
}
