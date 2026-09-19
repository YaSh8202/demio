const test = require("node:test")
const assert = require("node:assert")
const { sandboxEnv, isAllowed } = require("./sandbox-env-pure.cjs")

const parent = {
  HOME: "/Users/x",
  USER: "x",
  PATH: "/usr/bin",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TMPDIR: "/tmp/",
  AGENT_BROWSER_DEFAULT_TIMEOUT: "30000",
  // everything below must never reach the agent's shell
  GOOGLE_API_KEY: "AIza-secret",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  PHOENIX_API_KEY: "px-secret",
  AWS_BEARER_TOKEN_BEDROCK: "aws-secret",
  AXIOM_TOKEN: "ax-secret",
  AGENT_BROWSER_ENCRYPTION_KEY: "vault-secret",
  GITHUB_TOKEN: "gh-secret",
  DATABASE_URL: "postgres://u:p@h/db",
  NODE_OPTIONS: "--inspect",
  npm_config_registry: "https://r",
}

test("sandboxEnv: no credential from the parent env survives", () => {
  const env = sandboxEnv(parent, {})
  const leaked = Object.values(env).filter((v) => /secret|postgres:/.test(v))
  assert.deepEqual(leaked, [])
})

test("sandboxEnv: keeps what a shell and agent-browser need", () => {
  const env = sandboxEnv(parent, {})
  assert.deepEqual(Object.keys(env).sort(), [
    "AGENT_BROWSER_DEFAULT_TIMEOUT",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "USER",
  ])
})

test("sandboxEnv: it is an allowlist — an unknown name is dropped without matching any pattern", () => {
  assert.equal(isAllowed("DATABASE_URL"), false)
  assert.equal(isAllowed("NODE_OPTIONS"), false)
  assert.equal(isAllowed("SOMETHING_NEW_NEXT_MONTH"), false)
})

test("sandboxEnv: an allowlisted prefix does not rescue a credential", () => {
  assert.equal(isAllowed("AGENT_BROWSER_ENCRYPTION_KEY"), false)
  assert.equal(isAllowed("AGENT_BROWSER_DEFAULT_TIMEOUT"), true)
})

test("sandboxEnv: the caller's extras always win and are not filtered", () => {
  const env = sandboxEnv(parent, {
    PATH: "/shim:/usr/bin",
    WORKSPACE: "/w",
    CI: "true",
  })
  assert.equal(env.PATH, "/shim:/usr/bin")
  assert.equal(env.WORKSPACE, "/w")
  assert.equal(env.CI, "true")
})

test("sandboxEnv: tolerates an empty or missing parent", () => {
  assert.deepEqual(sandboxEnv(undefined, { A: "1" }), { A: "1" })
})
