"use client"

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { MessageResponse } from "@/components/ai-elements/message"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { DynamicToolUIPart, ReasoningUIPart, ToolUIPart } from "ai"
import type { UIMessage } from "@electron/store/types"
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileTextIcon,
  LockIcon,
  MessageSquareIcon,
  VideoIcon,
} from "lucide-react"

type ThreadMessagePart = UIMessage["parts"][number]
type ThreadReasoningPart = ReasoningUIPart
type ThreadToolPart = ToolUIPart | DynamicToolUIPart
type ThreadToolState = ThreadToolPart["state"]

interface PresentedFile {
  path: string
  kind: "video" | "text" | "error"
  absPath?: string
  sizeBytes?: number
  content?: string
  truncated?: boolean
  error?: string
}

interface PresentFilesOutput {
  files: PresentedFile[]
  hasVideo: boolean
}

interface ReadToolInput {
  filePath?: string
  offset?: number
  limit?: number
}

interface EditToolInput {
  filePath?: string
}

interface EditToolOutput {
  ok?: boolean
  filePath?: string
  replacements?: number
}

interface TerminalToolInput {
  command?: string
  timeoutMs?: number
  description?: string
}

interface TerminalToolOutput {
  ok?: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
  truncated?: boolean
  agentBrowserErrors?: string[]
  aborted?: boolean
  timedOut?: boolean
}

export function hasRenderableAssistantParts(
  parts: UIMessage["parts"]
): boolean {
  return parts.some((part) => {
    if (part.type === "text") {
      return !!(part as { text?: string }).text?.trim().length
    }

    if (part.type === "reasoning") {
      return !!(part as { text?: string }).text?.trim().length
    }

    return isThreadToolPart(part)
  })
}

export function ThreadAssistantPartRenderer({
  messageId,
  parts,
  isMessageStreaming,
  onVideoReady,
}: {
  messageId: string
  parts: UIMessage["parts"]
  isMessageStreaming: boolean
  onVideoReady?: (absPath: string) => void
}) {
  const renderedParts: ReactNode[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    const key = `message-${messageId}-part-${index}`

    if (part.type === "reasoning") {
      const reasoningPart = part as ThreadReasoningPart
      const reasoningText = reasoningPart.text
      if (!reasoningText) continue

      renderedParts.push(
        <Reasoning
          isStreaming={isReasoningPartStreaming(reasoningPart)}
          defaultOpen={false}
          key={key}
        >
          <ReasoningTrigger />
          <ReasoningContent>{reasoningText}</ReasoningContent>
        </Reasoning>
      )
      continue
    }

    if (part.type === "text") {
      const text = (part as { text?: string }).text
      if (!text) continue

      renderedParts.push(
        <MessageResponse isAnimating={isMessageStreaming} key={key}>
          {text}
        </MessageResponse>
      )
      continue
    }

    if (!isThreadToolPart(part)) continue

    const toolPart = part

    if (isClusterableToolPart(toolPart)) {
      const clusteredParts = [toolPart]
      let scanIndex = index + 1
      let lastClusteredIndex = index

      while (scanIndex < parts.length) {
        const candidate = parts[scanIndex] as ThreadMessagePart

        if (isStructuralPart(candidate)) {
          scanIndex += 1
          continue
        }

        if (!isClusterableToolPart(candidate)) {
          break
        }

        clusteredParts.push(candidate as ThreadToolPart)
        lastClusteredIndex = scanIndex
        scanIndex += 1
      }

      index = lastClusteredIndex

      if (clusteredParts.length > 1) {
        renderedParts.push(
          <ToolClusterGroup
            key={clusteredParts[0]?.toolCallId ?? key}
            parts={clusteredParts}
          />
        )
      } else {
        renderedParts.push(
          <ThreadToolUsage
            key={toolPart.toolCallId ?? key}
            part={toolPart}
            onVideoReady={onVideoReady}
          />
        )
      }

      continue
    }

    renderedParts.push(
      <ThreadToolUsage
        key={toolPart.toolCallId ?? key}
        part={toolPart}
        onVideoReady={onVideoReady}
      />
    )
  }

  return <>{renderedParts}</>
}

function isThreadToolPart(part: ThreadMessagePart): part is ThreadToolPart {
  const type = part.type as string
  return type.startsWith("tool-") || type === "dynamic-tool"
}

function isReasoningPartStreaming(part: ThreadReasoningPart): boolean {
  return part.state === "streaming"
}

function isClusterableToolPart(part: ThreadMessagePart): boolean {
  if (!isThreadToolPart(part)) return false
  const name = getThreadToolName(part)
  return name !== "present_files" && name !== "ask_user"
}

function isStructuralPart(part: ThreadMessagePart): boolean {
  return part.type === "step-start"
}

function getThreadToolName(part: ThreadToolPart): string {
  return part.type === "dynamic-tool"
    ? part.toolName
    : part.type.split("-").slice(1).join("-")
}

function asObject<T extends object>(value: unknown): T | undefined {
  return typeof value === "object" && value !== null ? (value as T) : undefined
}

function isPendingToolState(state: ThreadToolState): boolean {
  return (
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested" ||
    state === "approval-responded"
  )
}

function normalizePath(filePath?: string): string | undefined {
  return filePath?.replaceAll("\\", "/")
}

function getPathBasename(filePath?: string): string | undefined {
  const normalized = normalizePath(filePath)?.replace(/\/+$/, "")
  if (!normalized) return undefined

  const segments = normalized.split("/")
  return segments.at(-1) || normalized
}

type ToolClusterKind = "read" | "edit" | "terminal" | "other"

function getClusterKind(part: ThreadToolPart): ToolClusterKind {
  const toolName = getThreadToolName(part)

  if (toolName === "read") return "read"
  if (toolName === "edit") return "edit"
  if (toolName === "terminal") return "terminal"
  return "other"
}

function getToolClusterSummary(parts: ThreadToolPart[]): string {
  const buckets = new Map<
    ToolClusterKind,
    { count: number; firstIndex: number; pending: boolean }
  >()

  parts.forEach((part, index) => {
    const kind = getClusterKind(part)
    const existing = buckets.get(kind)

    if (existing) {
      existing.count += 1
      existing.pending ||= isPendingToolState(part.state)
      return
    }

    buckets.set(kind, {
      count: 1,
      firstIndex: index,
      pending: isPendingToolState(part.state),
    })
  })

  return [...buckets.entries()]
    .sort(([, a], [, b]) => a.firstIndex - b.firstIndex)
    .map(([kind, bucket]) => {
      if (kind === "read") {
        return `${bucket.pending ? "reading" : "read"} ${bucket.count} ${
          bucket.count === 1 ? "file" : "files"
        }`
      }

      if (kind === "edit") {
        return `${bucket.pending ? "editing" : "edited"} ${bucket.count} ${
          bucket.count === 1 ? "file" : "files"
        }`
      }

      if (kind === "terminal") {
        return `${bucket.pending ? "running" : "ran"} ${bucket.count} ${
          bucket.count === 1 ? "command" : "commands"
        }`
      }

      return `used ${bucket.count} ${bucket.count === 1 ? "tool" : "tools"}`
    })
    .join(", ")
}

function appendTerminalTranscript(
  transcript: string,
  segment?: string
): string {
  if (!segment) return transcript
  if (!transcript) return segment

  return transcript.endsWith("\n") || segment.startsWith("\n")
    ? transcript + segment
    : `${transcript}\n${segment}`
}

function getTerminalTranscript(
  output?: TerminalToolOutput,
  errorText?: string
): string {
  let transcript = ""
  transcript = appendTerminalTranscript(transcript, output?.stdout)
  transcript = appendTerminalTranscript(transcript, output?.stderr)
  transcript = appendTerminalTranscript(transcript, errorText)
  return transcript
}

function getTerminalMetadata(output?: TerminalToolOutput): string[] {
  if (!output) return []

  const metadata: string[] = []
  if (output.timedOut) metadata.push("Timed out")
  if (output.aborted) metadata.push("Stopped early")
  if (output.truncated) metadata.push("Output truncated")
  if (typeof output.exitCode === "number" && output.exitCode !== 0) {
    metadata.push(`Exit code ${output.exitCode}`)
  }
  if (output.agentBrowserErrors?.length) {
    metadata.push(
      `${output.agentBrowserErrors.length} agent-browser error${output.agentBrowserErrors.length === 1 ? "" : "s"}`
    )
  }

  return metadata
}

function getTerminalPlaceholder(state: ThreadToolState): string {
  if (state === "input-streaming") return "Preparing command..."
  if (state === "input-available") return "Running command..."
  if (state === "output-error") return "Command failed with no output."
  return "Command completed with no output."
}

// function getReplacementSummary(count?: number): string | undefined {
//   if (typeof count !== "number") return undefined
//   return `${count} replacement${count === 1 ? "" : "s"}`
// }

function ToolClusterGroup({ parts }: { parts: ThreadToolPart[] }) {
  const hasErrors = parts.some((part) => !!part.errorText)
  const [open, setOpen] = useState(hasErrors)
  const summary = getToolClusterSummary(parts)

  return (
    <Collapsible className="group w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-0.5 text-left transition-colors hover:text-foreground">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-muted-foreground">
          {summary}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1">
        <div className="mt-1 rounded-md bg-muted/20 px-3 py-2">
          <div className="flex flex-col gap-0.5">
            {parts.map((part) => (
              <ThreadToolUsage key={part.toolCallId} part={part} />
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ReadToolRow({ part }: { part: ThreadToolPart }) {
  const input = asObject<ReadToolInput>(part.input)
  const filePath = input?.filePath
  const meta: string[] = []

  if (typeof input?.offset === "number") meta.push(`offset=${input.offset}`)
  if (typeof input?.limit === "number") meta.push(`limit=${input.limit}`)

  return (
    <CompactToolSummary
      error={part.errorText}
      label="Read"
      meta={meta}
      subtitle={getPathBasename(filePath) ?? "filesystem"}
    />
  )
}

function EditToolRow({ part }: { part: ThreadToolPart }) {
  const input = asObject<EditToolInput>(part.input)
  const output = asObject<EditToolOutput>(part.output)
  const filePath = input?.filePath ?? output?.filePath
  // const summary = getReplacementSummary(output?.replacements)
  // const meta = summary
  //   ? [summary]
  //   : isPendingToolState(part.state)
  //     ? ["Applying edit..."]
  //     : []

  return (
    <CompactToolSummary
      className={cn(part.errorText && "bg-destructive/5")}
      // directory={getPathDirname(filePath)}
      error={part.errorText}
      label="Edit"
      // meta={meta}
      subtitle={getPathBasename(filePath) ?? "file"}
    />
  )
}

function TerminalToolCard({ part }: { part: ThreadToolPart }) {
  const [isCopied, setIsCopied] = useState(false)
  const [open, setOpen] = useState(!!part.errorText)
  const input = asObject<TerminalToolInput>(part.input)
  const output = asObject<TerminalToolOutput>(part.output)
  const command = input?.command?.trim()
  const transcript = getTerminalTranscript(output, part.errorText)
  const metadata = getTerminalMetadata(output)
  const summary = input?.description?.trim()
  // const rowMeta = isPendingToolState(part.state) ? ["Running command..."] : []

  useEffect(() => {
    if (!isCopied) return
    const timer = window.setTimeout(() => setIsCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [isCopied])

  function handleCopyCommand() {
    if (!command) return

    void navigator.clipboard
      .writeText(command)
      .then(() => setIsCopied(true))
      .catch(() => undefined)
  }

  return (
    <Collapsible className="group w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-0.5 text-left transition-colors hover:text-foreground">
        <CompactToolSummary
          error={part.errorText}
          label="Shell"
          // meta={rowMeta}
          subtitle={summary}
        />
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1">
        <div className="mt-1 flex flex-col gap-1.5">
          <div className="relative overflow-hidden rounded-lg border border-border/70 bg-surface text-surface-foreground shadow-sm">
            {command && (
              <Button
                className="absolute top-1.5 right-1.5 z-10"
                onClick={handleCopyCommand}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
                <span className="sr-only">Copy command</span>
              </Button>
            )}

            <pre className="max-h-[26rem] overflow-auto px-3 py-2 pr-10 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap">
              <span className="text-muted-foreground">$ </span>
              {command ?? "shell command"}
              {"\n\n"}
              {transcript || getTerminalPlaceholder(part.state)}
            </pre>
          </div>

          {metadata.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {metadata.map((item) => (
                <MetaChip key={item}>{item}</MetaChip>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface AskUserQuestionInput {
  question?: string
  header?: string
  secret?: boolean
}

interface AskUserToolInput {
  questions?: AskUserQuestionInput[]
}

interface AskUserToolOutput {
  ok?: boolean
  answers?: string[][]
  reason?: string
  message?: string
}

function AskUserToolCard({ part }: { part: ThreadToolPart }) {
  const input = asObject<AskUserToolInput>(part.input)
  const output = asObject<AskUserToolOutput>(part.output)
  const questions = input?.questions ?? []
  const answers = output?.answers ?? []

  if (part.state === "input-streaming" || part.state === "input-available") {
    const headers = questions
      .map((q) => q.header)
      .filter(Boolean)
      .join(" · ")
    return (
      <div className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2">
        <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
          {headers
            ? `Waiting for your answer — ${headers}`
            : "Waiting for your answer…"}
        </span>
        <span className="pulse-dot size-1.5 rounded-full bg-amber-400" />
      </div>
    )
  }

  if (part.state === "output-error") {
    return (
      <CompactToolSummary
        label="Ask"
        subtitle={part.errorText ?? "Question dismissed"}
        error={part.errorText}
      />
    )
  }

  if (part.state === "output-available") {
    if (output?.ok === false) {
      return (
        <CompactToolSummary
          label="Ask"
          subtitle={output.message ?? "User dismissed the question"}
        />
      )
    }
    return <AskUserAnsweredCollapsible questions={questions} answers={answers} />
  }

  return null
}

function AskUserAnsweredCollapsible({
  questions,
  answers,
}: {
  questions: AskUserQuestionInput[]
  answers: string[][]
}) {
  const [open, setOpen] = useState(false)

  const single = questions.length === 1
  const summarySubtitle = single
    ? questions[0]?.header || "1 question"
    : `${questions.length} questions${
        questions.some((q) => q.secret) ? " · includes secret" : ""
      }`

  return (
    <Collapsible className="group w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-0.5 text-left transition-colors hover:text-foreground">
        <CompactToolSummary label="Ask" subtitle={summarySubtitle} />
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1">
        <div className="mt-1 overflow-hidden rounded-lg border border-border/70 bg-muted/20">
          <div className="divide-y divide-border/40">
            {questions.map((q, i) => {
              const ans = answers[i] ?? []
              const isSecret = q.secret === true
              const hasAnswer = ans.length > 0
              const display = isSecret
                ? "•••••••"
                : hasAnswer
                  ? ans.join(", ")
                  : "(no answer)"

              return (
                <div className="px-3 py-2" key={i}>
                  <p className="text-[12px] leading-5 text-muted-foreground">
                    {q.question}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5">
                    {isSecret && (
                      <LockIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <p
                      className={cn(
                        "text-[13px] leading-5",
                        hasAnswer || isSecret
                          ? "font-medium text-foreground"
                          : "text-muted-foreground italic"
                      )}
                    >
                      {display}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ThreadToolUsage({
  part,
  onVideoReady,
}: {
  part: ThreadToolPart
  onVideoReady?: (absPath: string) => void
}) {
  const toolName = getThreadToolName(part)

  if (
    toolName === "present_files" &&
    part.state === "output-available" &&
    part.output
  ) {
    return (
      <PresentFilesContent
        onVideoReady={onVideoReady}
        output={part.output as PresentFilesOutput}
      />
    )
  }

  if (toolName === "terminal") {
    return <TerminalToolCard part={part} />
  }

  if (toolName === "read") {
    return <ReadToolRow part={part} />
  }

  if (toolName === "edit") {
    return <EditToolRow part={part} />
  }

  if (toolName === "ask_user") {
    return <AskUserToolCard part={part} />
  }

  return (
    <Tool>
      {part.type === "dynamic-tool" ? (
        <ToolHeader
          state={part.state}
          toolName={toolName}
          type="dynamic-tool"
        />
      ) : (
        <ToolHeader state={part.state} type={part.type} />
      )}
      <ToolContent>
        {part.input !== undefined && <ToolInput input={part.input} />}
        {(part.output !== undefined || part.errorText) && (
          <ToolOutput errorText={part.errorText} output={part.output} />
        )}
      </ToolContent>
    </Tool>
  )
}

function PresentFilesContent({
  output,
  onVideoReady,
}: {
  output: PresentFilesOutput
  onVideoReady?: (absPath: string) => void
}) {
  const videoTriggered = useRef(false)

  useEffect(() => {
    if (videoTriggered.current || !onVideoReady) return

    const videoFile = output.files.find(
      (file) => file.kind === "video" && file.absPath
    )
    if (!videoFile?.absPath) return

    videoTriggered.current = true
    onVideoReady(videoFile.absPath)
  }, [output, onVideoReady])

  return (
    <div className="flex flex-col gap-2">
      {output.files.map((file) => {
        if (file.kind === "video") {
          const sizeMB = file.sizeBytes
            ? (file.sizeBytes / 1_048_576).toFixed(1)
            : "?"

          return (
            <div
              className="flex items-center gap-2 rounded-md border border-sidebar-border bg-muted/50 px-3 py-2"
              key={file.path}
            >
              <VideoIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {file.path}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {sizeMB} MB
              </span>
            </div>
          )
        }

        if (file.kind === "text") {
          return (
            <div className="flex flex-col gap-1" key={file.path}>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <FileTextIcon className="size-3" />
                {file.path}
                {file.truncated && (
                  <span className="text-yellow-500">(truncated)</span>
                )}
              </div>
              <div className="max-h-96 overflow-auto rounded-md bg-muted/50 p-3">
                {/* {file.content} */}
                <MessageResponse>
                  {file.content || "No content available."}
                </MessageResponse>
              </div>
            </div>
          )
        }

        return (
          <div className="text-sm text-destructive" key={file.path}>
            {file.path}: {file.error}
          </div>
        )
      })}
    </div>
  )
}

function CompactToolSummary({
  label,
  subtitle,
  directory,
  meta = [],
  error,
  className,
}: {
  label: string
  subtitle?: string
  directory?: string
  meta?: string[]
  error?: string
  className?: string
}) {
  return (
    <div className={cn("min-w-0 flex-1 py-0.5", className)}>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-[13px] leading-5 font-medium text-foreground">
          {label}
        </span>
        {subtitle && (
          <span className="min-w-0 truncate text-[13px] leading-5 text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>

      {(directory || meta.length > 0) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          {directory && (
            <span className="max-w-full truncate text-muted-foreground/85">
              {directory}
            </span>
          )}
          {meta.map((item) => (
            <MetaChip key={item}>{item}</MetaChip>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-0.5 text-[11px] leading-4 text-destructive">{error}</p>
      )}
    </div>
  )
}

function MetaChip({ className, children }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "rounded-full border border-border/70 bg-muted/70 px-1.5 py-0 text-[10px] leading-4 text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  )
}
