// ── Present Files Tool ──────────────────────────────────────────────────────
//
// Lets the agent present files to the user in the chat UI.
//   - Video files (.mp4, .webm, .mov): auto-opens the video player panel
//   - Text files: content shown inline in chat
//
// The agent's tool loop stops after calling this tool (via hasToolCall stop
// condition in the orchestrator), so it should summarise before calling.

import fs from "node:fs"
import path from "node:path"
import { tool } from "ai"
import { z } from "zod"

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"])
const MAX_TEXT_BYTES = 20_000

export interface PresentFilesToolOptions {
  cwd: string
}

export function createPresentFilesTool({ cwd }: PresentFilesToolOptions) {
  return tool({
    description: `Present files to the user in the chat interface.

Use this after producing output files the user needs to see or approve:
- Video files (mp4, webm, mov): opens the video player in the right panel automatically.
- Text files (md, txt, log, json, etc.): content is shown inline in the chat.

Always use workspace-relative paths (e.g. "output/demo.mp4", "script.md").

IMPORTANT: After calling this tool your turn ends automatically. Write your summary or commentary as a text message BEFORE calling this tool.`,

    inputSchema: z.object({
      files: z
        .array(z.string())
        .min(1)
        .describe(
          'Workspace-relative file paths to present (e.g. ["output/demo.mp4", "script.md"])'
        ),
    }),

    execute: async ({ files }) => {
      const results = files.map((relPath) => {
        const absPath = path.resolve(cwd, relPath)

        // Security: reject paths that escape the workspace
        if (!absPath.startsWith(cwd + path.sep) && absPath !== cwd) {
          return {
            path: relPath,
            kind: "error" as const,
            error: "Path escapes workspace",
          }
        }

        if (!fs.existsSync(absPath)) {
          return {
            path: relPath,
            kind: "error" as const,
            error: "File not found",
          }
        }

        const ext = path.extname(absPath).toLowerCase()

        if (VIDEO_EXTENSIONS.has(ext)) {
          const stat = fs.statSync(absPath)
          return {
            path: relPath,
            absPath,
            kind: "video" as const,
            sizeBytes: stat.size,
          }
        }

        // Text file: read and truncate
        const raw = fs.readFileSync(absPath, "utf-8")
        const truncated = raw.length > MAX_TEXT_BYTES
        return {
          path: relPath,
          kind: "text" as const,
          content: truncated
            ? raw.slice(0, MAX_TEXT_BYTES) +
              `\n… [truncated ${raw.length - MAX_TEXT_BYTES} chars]`
            : raw,
          truncated,
        }
      })

      const hasVideo = results.some((r) => r.kind === "video")
      return { files: results, hasVideo }
    },
  })
}
