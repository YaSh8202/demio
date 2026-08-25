// Pure replay logic for the deterministic record pass. CommonJS so
// `node --test` runs it with zero build step (same pattern as
// verify-pure.cjs / edl-pure.cjs). No I/O — the step loop added in Task 2
// takes its exec function as a parameter.
"use strict"

const DEFAULT_SETTLE_MS = 600

/**
 * Apply defaults to a raw script object and validate the one invariant the
 * zod schema cannot express usefully at runtime in .cjs. Mirrors
 * `sceneScriptSchema` in script-schema.ts — keep the two in step.
 */
function normalizeScript(raw) {
  if (!raw || !Array.isArray(raw.actions) || raw.actions.length === 0) {
    throw new Error("script must have at least one action")
  }
  return {
    sceneId: String(raw.sceneId),
    continuity: raw.continuity === "chained" ? "chained" : "independent",
    oneShot: raw.oneShot === true,
    startUrl: String(raw.startUrl),
    endUrl: String(raw.endUrl),
    actions: raw.actions.map((a) => ({
      cmd: String(a.cmd),
      assert: typeof a.assert === "string" ? a.assert : undefined,
      settleMs:
        typeof a.settleMs === "number" ? a.settleMs : DEFAULT_SETTLE_MS,
      narrationAnchor:
        typeof a.narrationAnchor === "number" ? a.narrationAnchor : undefined,
    })),
  }
}

module.exports = { normalizeScript, DEFAULT_SETTLE_MS }
