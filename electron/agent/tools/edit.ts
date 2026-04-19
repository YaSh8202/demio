import { tool } from "ai"
import { z } from "zod"
import * as fsPromises from "node:fs/promises"
import * as path from "node:path"

export interface EditToolOptions {
  cwd: string
}

export function createEditTool({ cwd }: EditToolOptions) {
  return tool({
    description: `Edit a file by replacing a specific string with a new string.

The oldString must appear exactly in the file. If it appears multiple times and you only want to replace one, make oldString more specific by including surrounding context. Use replaceAll: true to replace every occurrence.

Paths can be workspace-relative or absolute.`,

    inputSchema: z.object({
      filePath: z
        .string()
        .describe("Absolute or workspace-relative path to the file to edit"),
      oldString: z
        .string()
        .describe("The exact text to find in the file"),
      newString: z
        .string()
        .describe("The text to replace oldString with (must differ from oldString)"),
      replaceAll: z
        .boolean()
        .optional()
        .describe("Replace all occurrences (default: false — replaces only the first)"),
    }),

    execute: async ({ filePath, oldString, newString, replaceAll = false }) => {
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(cwd, filePath)

      let content: string
      try {
        content = await fsPromises.readFile(absPath, "utf-8")
      } catch {
        throw new Error(`File not found: ${absPath}`)
      }

      if (oldString === newString) {
        throw new Error("oldString and newString must be different")
      }

      if (!content.includes(oldString)) {
        throw new Error(
          `oldString not found in ${path.relative(cwd, absPath)}`
        )
      }

      let replacements = 0
      let newContent: string

      if (replaceAll) {
        let idx = 0
        while ((idx = content.indexOf(oldString, idx)) !== -1) {
          replacements++
          idx += oldString.length
        }
        newContent = content.split(oldString).join(newString)
      } else {
        newContent = content.replace(oldString, newString)
        replacements = 1
      }

      await fsPromises.writeFile(absPath, newContent, "utf-8")

      return {
        ok: true,
        filePath: path.relative(cwd, absPath),
        replacements,
      }
    },
  })
}
