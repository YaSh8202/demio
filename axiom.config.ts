// Axiom eval runner config. `bun run eval -- --debug` runs every
// `electron/**/*.eval.ts` locally with no network; without `--debug` the
// results are sent to the dataset named in the env vars below, which are
// optional for local runs. See docs/superpowers/plans/evals.md.

import { defineConfig } from "axiom/ai/config"
import { flagSchema } from "./electron/agent/app-scope"

export default defineConfig({
  eval: {
    url: process.env.AXIOM_URL,
    token: process.env.AXIOM_TOKEN,
    dataset: process.env.AXIOM_DATASET,
    include: ["electron/**/*.eval.ts"],
    flagSchema,
    // A task is one or more real model calls; the 60s default is tight
    // for a tool-use loop.
    timeoutMs: 120_000,
  },
})
