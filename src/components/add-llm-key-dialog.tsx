// ── Add LLM Key Dialog ──────────────────────────────────────────────────────
//
// Modal for adding a new LLM provider API key.
// Validates the key against the provider's API before storing.

import { useState, useEffect } from "react"
import { ExternalLink, Key, Loader2, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector"
import { LLMProvider, LLM_PROVIDER_NAMES } from "@/types/models"
import type { ProviderKeyInfo } from "@/types/models"

const PROVIDER_API_KEY_URLS: Record<
  LLMProvider,
  { url: string; label: string }
> = {
  [LLMProvider.OPENAI]: {
    url: "https://platform.openai.com/api-keys",
    label: "OpenAI Platform",
  },
  [LLMProvider.ANTHROPIC]: {
    url: "https://console.anthropic.com/settings/keys",
    label: "Anthropic Console",
  },
  [LLMProvider.GOOGLE]: {
    url: "https://aistudio.google.com/apikey",
    label: "Google AI Studio",
  },
  [LLMProvider.AMAZON_BEDROCK]: {
    url: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    label: "AWS Bedrock Console",
  },
}

const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-northeast-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "ca-central-1",
  "sa-east-1",
]

interface AddLLMKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingProviders: LLMProvider[]
  initialProvider?: LLMProvider
  onAddKey: (params: {
    provider: string
    apiKey: string
    metadata?: Record<string, string>
  }) => Promise<ProviderKeyInfo>
}

export function AddLLMKeyDialog({
  open,
  onOpenChange,
  existingProviders,
  initialProvider,
  onAddKey,
}: AddLLMKeyDialogProps) {
  const [provider, setProvider] = useState<LLMProvider>(
    initialProvider || LLMProvider.OPENAI
  )
  const [apiKey, setApiKey] = useState("")
  const [region, setRegion] = useState<string>(BEDROCK_REGIONS[0])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setApiKey("")
      setRegion(BEDROCK_REGIONS[0])
      setError(null)
      setIsSubmitting(false)
      if (initialProvider) setProvider(initialProvider)
    }
  }, [open, initialProvider])

  const availableProviders = Object.values(LLMProvider).filter(
    (p) => !existingProviders.includes(p)
  )

  // Auto-select first available if current is taken
  useEffect(() => {
    if (
      availableProviders.length > 0 &&
      existingProviders.includes(provider)
    ) {
      setProvider(availableProviders[0])
    }
  }, [existingProviders])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim() || apiKey.trim().length < 10) {
      setError("API key seems too short")
      return
    }
    if (provider === LLMProvider.AMAZON_BEDROCK && !region) {
      setError("AWS region is required for Amazon Bedrock")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const metadata =
        provider === LLMProvider.AMAZON_BEDROCK ? { region } : undefined
      await onAddKey({ provider, apiKey: apiKey.trim(), metadata })
      onOpenChange(false)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to add API key"
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const providerUrl = PROVIDER_API_KEY_URLS[provider]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <Key className="text-primary" />
            </div>
            <div>
              <DialogTitle className="text-left">Add API Key</DialogTitle>
              <DialogDescription className="text-left text-sm">
                Connect your LLM provider securely
              </DialogDescription>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
            <Shield className="text-green-600" />
            <p className="text-xs text-muted-foreground">
              Your API keys are encrypted using your OS keychain
            </p>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Provider selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Provider</label>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as LLMProvider)}
            >
              <SelectTrigger className="h-12">
                <SelectValue>
                  <div className="flex items-center gap-3">
                    <ModelSelectorLogo
                      provider={provider}
                      className="size-5"
                    />
                    <span className="font-medium">
                      {LLM_PROVIDER_NAMES[provider]}
                    </span>
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {availableProviders.length === 0 ? (
                  <div className="p-3 text-center text-sm text-muted-foreground">
                    All providers have keys already
                  </div>
                ) : (
                  availableProviders.map((p) => (
                    <SelectItem key={p} value={p} className="py-3">
                      <div className="flex items-center gap-3">
                        <ModelSelectorLogo
                          provider={p}
                          className="size-5"
                        />
                        <span className="font-medium">
                          {LLM_PROVIDER_NAMES[p]}
                        </span>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* API Key input */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">API Key</label>
            <Input
              type="password"
              placeholder="sk-... or your provider's API key format"
              className="h-12"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setError(null)
              }}
              autoComplete="off"
            />
            {providerUrl && (
              <div className="flex items-center gap-2">
                <ExternalLink className="size-3 text-muted-foreground" />
                <a
                  href={providerUrl.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary underline underline-offset-4 hover:text-primary/80"
                >
                  Get your API key from {providerUrl.label}
                </a>
              </div>
            )}
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </div>

          {/* AWS Region (Bedrock only) */}
          {provider === LLMProvider.AMAZON_BEDROCK && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">AWS Region</label>
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger className="h-12">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BEDROCK_REGIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="h-11"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || availableProviders.length === 0}
              className="h-11"
            >
              {isSubmitting && (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              )}
              {isSubmitting ? "Validating..." : "Add Key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
