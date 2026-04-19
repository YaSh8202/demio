import { tool } from "ai"
import { z } from "zod"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { createReadStream } from "node:fs"

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
}

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar",
  ".war", ".7z", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
  ".mp4", ".mp3", ".wav", ".avi", ".mov", ".mkv", ".webm", ".flac",
  ".aac", ".ogg",
])

export interface ReadToolOptions {
  cwd: string
}

export function createReadTool({ cwd }: ReadToolOptions) {
  return tool({
    description: `Read a file or directory from the filesystem.

- Text files: returns content with line numbers (format: "N: line content")
- Images (.png, .jpg, .gif, .webp, .bmp, .tiff): returns the image so you can see it
- Directories: returns a listing of entries
- Use offset/limit to paginate large files (offset is 1-indexed line number)

Paths can be workspace-relative or absolute.`,

    inputSchema: z.object({
      filePath: z
        .string()
        .describe("Absolute or workspace-relative path to the file or directory"),
      offset: z
        .number()
        .int()
        .optional()
        .describe("Line number to start reading from (1-indexed, default 1)"),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of lines to read (default 2000)"),
    }),

    execute: async ({ filePath, offset, limit }) => {
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(cwd, filePath)

      let stat: fs.Stats
      try {
        stat = await fsPromises.stat(absPath)
      } catch {
        const dir = path.dirname(absPath)
        const base = path.basename(absPath)
        const suggestions = await fsPromises
          .readdir(dir)
          .then((entries) =>
            entries
              .filter(
                (e) =>
                  e.toLowerCase().includes(base.toLowerCase()) ||
                  base.toLowerCase().includes(e.toLowerCase())
              )
              .slice(0, 3)
              .map((e) => path.join(dir, e))
          )
          .catch(() => [] as string[])

        if (suggestions.length > 0) {
          throw new Error(
            `File not found: ${absPath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
          )
        }
        throw new Error(`File not found: ${absPath}`)
      }

      // ── Directory ────────────────────────────────────────────────────────────
      if (stat.isDirectory()) {
        const dirents = await fsPromises.readdir(absPath, {
          withFileTypes: true,
        })
        const entries = await Promise.all(
          dirents.map(async (dirent) => {
            if (dirent.isDirectory()) return dirent.name + "/"
            if (dirent.isSymbolicLink()) {
              const target = await fsPromises
                .stat(path.join(absPath, dirent.name))
                .catch(() => undefined)
              if (target?.isDirectory()) return dirent.name + "/"
            }
            return dirent.name
          })
        )
        entries.sort((a, b) => a.localeCompare(b))

        const effectiveLimit = limit ?? DEFAULT_LIMIT
        const start = Math.max((offset ?? 1) - 1, 0)
        const sliced = entries.slice(start, start + effectiveLimit)
        const truncated = start + sliced.length < entries.length

        let output = [
          `<path>${absPath}</path>`,
          `<type>directory</type>`,
          `<entries>`,
          sliced.join("\n"),
        ].join("\n")
        output += truncated
          ? `\n\n(Showing ${sliced.length} of ${entries.length} entries. Use offset=${start + sliced.length + 1} to continue.)`
          : `\n\n(${entries.length} entries)`
        output += "\n</entries>"

        return { ok: true as const, output, truncated }
      }

      // ── Image ────────────────────────────────────────────────────────────────
      const ext = path.extname(absPath).toLowerCase()
      const imageMime = IMAGE_EXTENSIONS[ext]
      if (imageMime) {
        const data = await fsPromises.readFile(absPath)
        return [
          { type: "image" as const, data: data.toString("base64"), mimeType: imageMime },
          { type: "text" as const, text: "Image read successfully" },
        ]
      }

      // ── Binary guard ─────────────────────────────────────────────────────────
      if (BINARY_EXTENSIONS.has(ext) || (await hasBinaryContent(absPath, stat.size))) {
        throw new Error(`Cannot read binary file: ${absPath}`)
      }

      // ── Text file ────────────────────────────────────────────────────────────
      const effectiveLimit = limit ?? DEFAULT_LIMIT
      const effectiveOffset = offset ?? 1
      if (effectiveOffset < 1) throw new Error("offset must be >= 1")
      const startLine = effectiveOffset - 1

      const stream = createReadStream(absPath, { encoding: "utf8" })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })

      const raw: string[] = []
      let bytes = 0
      let totalLines = 0
      let truncatedByBytes = false
      let hasMoreLines = false

      try {
        for await (const text of rl) {
          totalLines++
          if (totalLines <= startLine) continue
          if (raw.length >= effectiveLimit) {
            hasMoreLines = true
            continue
          }
          const line =
            text.length > MAX_LINE_LENGTH
              ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
              : text
          const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
          if (bytes + size > MAX_BYTES) {
            truncatedByBytes = true
            hasMoreLines = true
            break
          }
          raw.push(line)
          bytes += size
        }
      } finally {
        rl.close()
        stream.destroy()
      }

      if (totalLines < effectiveOffset - 1 && !(totalLines === 0 && effectiveOffset === 1)) {
        throw new Error(
          `Offset ${effectiveOffset} is out of range for this file (${totalLines} lines)`
        )
      }

      const content = raw.map((line, i) => `${i + effectiveOffset}: ${line}`)
      const lastReadLine = effectiveOffset + raw.length - 1
      const nextOffset = lastReadLine + 1
      const truncated = hasMoreLines || truncatedByBytes

      let output = [
        `<path>${absPath}</path>`,
        `<type>file</type>`,
        "<content>",
      ].join("\n")
      output += content.join("\n")

      if (truncatedByBytes) {
        output += `\n\n(Output capped at ${MAX_BYTES / 1024}KB. Showing lines ${effectiveOffset}–${lastReadLine}. Use offset=${nextOffset} to continue.)`
      } else if (hasMoreLines) {
        output += `\n\n(Showing lines ${effectiveOffset}–${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`
      } else {
        output += `\n\n(End of file — ${totalLines} lines total)`
      }
      output += "\n</content>"

      return { ok: true as const, output, truncated }
    },
  })
}

async function hasBinaryContent(
  filepath: string,
  fileSize: number
): Promise<boolean> {
  if (fileSize === 0) return false
  const fh = await fsPromises.open(filepath, "r")
  try {
    const sampleSize = Math.min(4096, fileSize)
    const bytes = Buffer.alloc(sampleSize)
    const result = await fh.read(bytes, 0, sampleSize, 0)
    if (result.bytesRead === 0) return false
    let nonPrintable = 0
    for (let i = 0; i < result.bytesRead; i++) {
      if (bytes[i] === 0) return true
      if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintable++
    }
    return nonPrintable / result.bytesRead > 0.3
  } finally {
    await fh.close()
  }
}
