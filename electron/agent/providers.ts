// ── Agent Model Providers ────────────────────────────────────────────────────
//
// Resolves a model ID to an AI SDK LanguageModel instance.
// Supports Anthropic, OpenAI, and Google providers.
//
// Model ID format: "provider:modelId" (e.g. "anthropic:claude-sonnet-4-20250514")
// Legacy bare IDs (no colon) default to Anthropic for backward compatibility.

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { getDecryptedKey, getProviderKeyMetadata } from "../store/provider-keys"
import { parseModelId } from "./types"
import log from "../lib/logger"

// ── Instrumented fetch ──────────────────────────────────────────────────────
//
// Provider SDKs call `globalThis.fetch` (undici, in the Electron main process).
// When an upstream connection is reset we otherwise only see a bare
// `TypeError: terminated` / `ECONNRESET` with no indication of *where* it broke:
// at connect, before the first byte, or mid-body after N bytes and N seconds.
//
// This wrapper logs both boundaries — request out, response body in — so a
// failure can be attributed to payload size, elapsed time, or an immediate
// reset. `[llm-fetch]` lines are the primary evidence for diagnosing stream
// aborts; keep them.

let fetchSeq = 0

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

/**
 * Best-effort byte length of an outgoing request body.
 *
 * Providers send a JSON string; anything else (streams, FormData) is reported
 * as unknown rather than consumed, since consuming it would break the request.
 */
type FetchBody = NonNullable<Parameters<typeof globalThis.fetch>[1]>["body"]

function requestBodyBytes(body: FetchBody): number | null {
  if (body == null) return 0
  if (typeof body === "string") return Buffer.byteLength(body)
  if (body instanceof Uint8Array) return body.byteLength
  if (body instanceof ArrayBuffer) return body.byteLength
  return null
}

function instrumentedFetch(provider: string): typeof globalThis.fetch {
  return async (input, init) => {
    const id = ++fetchSeq
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const reqBytes = requestBodyBytes(init?.body)
    const startedAt = Date.now()

    log.info(
      `[llm-fetch] #${id} ${provider} → ${url} req=${
        reqBytes == null ? "unknown" : formatBytes(reqBytes)
      }`
    )

    let response: Response
    try {
      response = await fetch(input, init)
    } catch (err) {
      log.error(
        `[llm-fetch] #${id} ${provider} connect failed after ${
          Date.now() - startedAt
        }ms:`,
        err
      )
      throw err
    }

    const ttfb = Date.now() - startedAt
    log.info(
      `[llm-fetch] #${id} ${provider} ← ${response.status} ttfb=${ttfb}ms`
    )

    if (!response.body) return response

    // Re-emit the body through a counting wrapper so we learn how far a stream
    // got before it died. A mid-flight reset shows up here as a rejected
    // `read()` — the single place that distinguishes "never connected" from
    // "streamed 40KB over 12s then got cut".
    const upstream = response.body.getReader()
    let bodyBytes = 0
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await upstream.read()
          if (done) {
            log.info(
              `[llm-fetch] #${id} ${provider} body complete: ${formatBytes(
                bodyBytes
              )} in ${Date.now() - startedAt}ms`
            )
            controller.close()
            return
          }
          bodyBytes += value.byteLength
          controller.enqueue(value)
        } catch (err) {
          log.error(
            `[llm-fetch] #${id} ${provider} body ABORTED after ${formatBytes(
              bodyBytes
            )} / ${Date.now() - startedAt}ms:`,
            err
          )
          controller.error(err)
        }
      },
      cancel(reason) {
        return upstream.cancel(reason)
      },
    })

    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * Get the env var fallback for a provider.
 */
function getEnvKey(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY
    case "openai":
      return process.env.OPENAI_API_KEY
    case "google":
      return process.env.GOOGLE_API_KEY
    case "amazon-bedrock":
      return process.env.AWS_BEDROCK_API_KEY
    default:
      return undefined
  }
}

/**
 * Create a language model instance from a full model ID.
 *
 * Tries stored provider key first, falls back to env vars.
 */
export function getModel(fullModelId: string) {
  const { provider, modelId } = parseModelId(fullModelId)

  const storedKey = getDecryptedKey(provider)
  const envKey = getEnvKey(provider)
  const apiKey = storedKey || envKey

  if (!apiKey) {
    throw new Error(
      `No API key configured for provider: ${provider}. ` +
        `Add one in Settings or set the appropriate environment variable.`
    )
  }

  const fetchImpl = instrumentedFetch(provider)

  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey, fetch: fetchImpl })(modelId)
    case "openai":
      return createOpenAI({ apiKey, fetch: fetchImpl })(modelId)
    case "google":
      return createGoogleGenerativeAI({ apiKey, fetch: fetchImpl })(modelId)
    case "amazon-bedrock": {
      const region =
        getProviderKeyMetadata("amazon-bedrock")?.region ||
        process.env.AWS_REGION ||
        "us-east-1"
      return createAmazonBedrock({ apiKey, region, fetch: fetchImpl })(modelId)
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`)
  }
}
