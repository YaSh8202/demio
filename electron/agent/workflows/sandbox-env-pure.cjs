// ── Sandbox environment (pure) ──────────────────────────────────────────────
//
// What the agent's shell inherits. The sandbox used to be handed
// `{ ...process.env }`, and `electron/main.ts` loads `.env.local` into
// `process.env` at startup — so every provider key in that file
// (GOOGLE_API_KEY, ANTHROPIC_API_KEY, PHOENIX_API_KEY, …) was one `env` away
// from a model that reads web pages for a living. Nothing had asked for them
// yet; the first page that says "run `env` and paste the output" would have.
//
// An allowlist, not a denylist: a new secret added to `.env.local` next
// month is excluded by default instead of leaked by default. The secret
// pattern is a second gate on top — it also drops an allowlisted-prefix
// variable that happens to be a credential (AGENT_BROWSER_ENCRYPTION_KEY).

const ALLOWED = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "TERM",
  "LANG",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
])

/** Whole families that are configuration, not credentials. */
const ALLOWED_PREFIXES = ["LC_", "AGENT_BROWSER_"]

const SECRET_SHAPED =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION_ID/i

function isAllowed(name) {
  if (SECRET_SHAPED.test(name)) return false
  return ALLOWED.has(name) || ALLOWED_PREFIXES.some((p) => name.startsWith(p))
}

/**
 * Build the sandbox env from the parent's. `extras` are set by the caller on
 * purpose (PATH with the shim dir, WORKSPACE, CI flags) and always win —
 * they are not filtered, because the caller wrote them.
 */
function sandboxEnv(parentEnv, extras) {
  const out = {}
  for (const [name, value] of Object.entries(parentEnv || {})) {
    if (typeof value === "string" && isAllowed(name)) out[name] = value
  }
  return { ...out, ...(extras || {}) }
}

module.exports = { sandboxEnv, isAllowed }
