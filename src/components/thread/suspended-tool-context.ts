import { createContext, useContext } from "react"

/**
 * The `toolCallId` of the tool call currently suspended awaiting the user
 * (`ask_user`, `submit_plan`, a `generate_demo` scene that exhausted its
 * attempts), or `null`.
 *
 * A context rather than a prop because the two readers sit five components
 * apart from the one place that knows it (`ThreadShell`), and both need the
 * same answer to the same question: a suspended call is WAITING, which is
 * neither "still running" nor "died". The run has ended — the framework ends
 * it with reason `suspended` — so anything that infers liveness from
 * `isRunning` alone reads a paused call as an interrupted one.
 */
export const SuspendedToolCallContext = createContext<string | null>(null)

export function useSuspendedToolCallId(): string | null {
  return useContext(SuspendedToolCallContext)
}
