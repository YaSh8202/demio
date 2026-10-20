// A model request that stalls must FAIL, not hang: the agent loop awaits it,
// so a hang here is a turn that never ends — and nothing keyed on a turn
// ending (the stall watchdog included) ever runs. Found by a smoke run that
// sat 19 minutes on one request.
//
//   bun run test:harness

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

process.env.DEMIO_LLM_FIRST_BYTE_TIMEOUT_MS = "300"
process.env.DEMIO_LLM_STREAM_IDLE_TIMEOUT_MS = "300"

let fetchFor: typeof import("./providers").instrumentedFetch
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  fetchFor = (await import("./providers")).instrumentedFetch
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/never") return new Promise<Response>(() => {})
      if (path === "/half") {
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: first\n\n"))
              // …and then nothing, with the stream left open.
            },
          })
        )
      }
      return new Response("data: ok\n\n")
    },
  })
})
afterAll(() => server.stop(true))

const url = (p: string) => `http://localhost:${server.port}${p}`

describe("a stalled model request", () => {
  test("no response at all → rejects, named for what it is", async () => {
    const started = Date.now()
    await expect(fetchFor("test")(url("/never"))).rejects.toThrow(
      /model request stalled: no response/
    )
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test("a stream that goes quiet mid-body → the read rejects", async () => {
    const res = await fetchFor("test")(url("/half"))
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "first"
    )
    await expect(reader.read()).rejects.toThrow(/no data on an open stream/)
  })

  test("a healthy response is untouched, and leaves no timer behind", async () => {
    const res = await fetchFor("test")(url("/ok"))
    expect(await res.text()).toBe("data: ok\n\n")
    await new Promise((r) => setTimeout(r, 500)) // past both timeouts
  })

  test("the caller's own abort still wins", async () => {
    const ac = new AbortController()
    const p = fetchFor("test")(url("/never"), { signal: ac.signal })
    ac.abort(new Error("user cancelled"))
    await expect(p).rejects.toThrow(/user cancelled|abort/i)
  })
})
