// ── Fault injection ──────────────────────────────────────────────────────────
//
// The degrade ladder only matters when a stage fails, and a real stage fails
// when it likes. `DEMIO_FAULT` makes one fail on demand, so every rung can be
// proven by a test instead of by waiting for a bad day:
//
//   DEMIO_FAULT=sync:throw                 one fault
//   DEMIO_FAULT=tts:throw,scene:a.02:fail  several, comma-separated
//
//   <stage>:throw      narrate | tts | sync | compose — the stage throws
//   <stage>:hang       the stage never returns (until its budget aborts it)
//   scene:<id>:fail    that scene fails every take;  scene:*:fail — every scene
//
// Inert unless the variable is set: `maybeFault` is one env read and a return.
// It also works on a live run (`DEMIO_FAULT=sync:throw bun run smoke start …`)
// to watch a rung fire against a real site.

type Stage = "narrate" | "tts" | "sync" | "compose"

function faults(): string[] {
  const raw = process.env.DEMIO_FAULT
  return raw
    ? raw
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : []
}

/** Throw or hang here if `DEMIO_FAULT` names this stage. */
export async function maybeFault(
  stage: Stage,
  signal?: AbortSignal
): Promise<void> {
  const active = faults()
  if (active.length === 0) return
  if (active.includes(`${stage}:throw`)) {
    throw new Error(`injected fault: ${stage}:throw`)
  }
  if (active.includes(`${stage}:hang`)) {
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(new Error(`injected fault: ${stage}:hang — aborted by its budget`))
      )
    })
  }
}

/** True when `DEMIO_FAULT` says this scene must fail every take. */
export function sceneFaulted(sceneId: string): boolean {
  const active = faults()
  return (
    active.includes("scene:*:fail") || active.includes(`scene:${sceneId}:fail`)
  )
}
