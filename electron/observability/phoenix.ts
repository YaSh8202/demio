// ── Phoenix Tracing ──────────────────────────────────────────────────────────
//
// Initializes an OpenTelemetry tracer provider that exports OpenInference-formatted
// spans (from the AI SDK's experimental_telemetry hook) to a Phoenix collector.
//
// Off by default. Enable via `PHOENIX_ENABLED=true`. Requires
// `PHOENIX_COLLECTOR_ENDPOINT` and `PHOENIX_API_KEY` for Phoenix Cloud.

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import {
  OpenInferenceBatchSpanProcessor,
  isOpenInferenceSpan,
} from "@arizeai/openinference-vercel"
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions"
import log from "../lib/logger"

let provider: NodeTracerProvider | null = null
let enabled = false

export function isPhoenixEnabled(): boolean {
  return enabled
}

export function initPhoenix(): void {
  if (provider) return

  if (process.env.PHOENIX_ENABLED !== "true") return
  log.info("[phoenix] PHOENIX_ENABLED=true, initializing Phoenix tracing")

  const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT
  const apiKey = process.env.PHOENIX_API_KEY
  const projectName = process.env.PHOENIX_PROJECT_NAME || "demio"

  if (!endpoint) {
    log.warn(
      "[phoenix] PHOENIX_ENABLED=true but PHOENIX_COLLECTOR_ENDPOINT is unset — tracing disabled"
    )
    return
  }
  if (!apiKey) {
    log.warn(
      "[phoenix] PHOENIX_ENABLED=true but PHOENIX_API_KEY is unset — tracing disabled"
    )
    return
  }

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      api_key: apiKey,
    },
  })

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "demio-agent",
      [SEMRESATTRS_PROJECT_NAME]: projectName,
    }),
    spanProcessors: [
      new OpenInferenceBatchSpanProcessor({
        exporter,
        spanFilter: isOpenInferenceSpan,
      }),
    ],
  })
  provider.register()
  enabled = true

  log.info(`[phoenix] enabled, project=${projectName}, endpoint=${endpoint}`)
}

export async function shutdownPhoenix(): Promise<void> {
  if (!provider) return
  try {
    await provider.shutdown()
  } catch (err) {
    log.warn("[phoenix] shutdown error", err)
  }
  provider = null
  enabled = false
}
