// ── Provider Key Storage ─────────────────────────────────────────────────────
//
// Encrypted storage for LLM provider API keys using Electron's safeStorage.
// Keys are encrypted via the OS keychain (macOS Keychain, Windows DPAPI,
// Linux libsecret) and stored at ~/.demio/provider-keys.json.
//
// In-memory cache is maintained for fast reads. All writes are atomic.

import { safeStorage } from "electron"
import fs from "node:fs"
import path from "node:path"
import { nanoid } from "nanoid"
import log from "../lib/logger"
import { storeRoot, atomicWriteSync } from "./paths"

// ── Types ───────────────────────────────────────────────────────────────────

interface StoredKey {
  id: string
  provider: string
  encryptedKey: string // base64-encoded encrypted bytes
  isValid: boolean
  createdAt: string
  updatedAt: string
}

interface ProviderKeysFile {
  version: 1
  keys: StoredKey[]
}

export interface ProviderKeyInfo {
  id: string
  provider: string // LLMProvider value ("openai" | "anthropic" | "google")
  isValid: boolean
  createdAt: string
  updatedAt: string
}

// ── State ───────────────────────────────────────────────────────────────────

let cache: ProviderKeysFile = { version: 1, keys: [] }
let encryptionAvailable = false

function filePath(): string {
  return path.join(storeRoot(), "provider-keys.json")
}

// ── Init ────────────────────────────────────────────────────────────────────

export function initProviderKeys(): void {
  encryptionAvailable = safeStorage.isEncryptionAvailable()

  if (!encryptionAvailable) {
    log.warn(
      "[provider-keys] safeStorage encryption not available. Keys will be stored in plaintext."
    )
  }

  const fp = filePath()
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, "utf-8")
      cache = JSON.parse(raw) as ProviderKeysFile
    } catch {
      log.error("[provider-keys] Failed to read keys file, starting fresh")
      cache = { version: 1, keys: [] }
    }
  }

  log.log(
    `[provider-keys] Initialized with ${cache.keys.length} key(s), encryption: ${encryptionAvailable}`
  )
}

// ── Persistence ─────────────────────────────────────────────────────────────

function persist(): void {
  atomicWriteSync(filePath(), JSON.stringify(cache, null, 2))
}

// ── Encryption ──────────────────────────────────────────────────────────────

function encryptKey(apiKey: string): string {
  if (encryptionAvailable) {
    const encrypted = safeStorage.encryptString(apiKey)
    return encrypted.toString("base64")
  }
  // Fallback: base64 encode (NOT secure, but functional)
  return Buffer.from(apiKey, "utf-8").toString("base64")
}

function decryptKey(encryptedKey: string): string {
  if (encryptionAvailable) {
    const buffer = Buffer.from(encryptedKey, "base64")
    return safeStorage.decryptString(buffer)
  }
  // Fallback: base64 decode
  return Buffer.from(encryptedKey, "base64").toString("utf-8")
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Get all keys (without decrypted values) for the renderer. */
export function getProviderKeys(): ProviderKeyInfo[] {
  return cache.keys.map(({ id, provider, isValid, createdAt, updatedAt }) => ({
    id,
    provider,
    isValid,
    createdAt,
    updatedAt,
  }))
}

/** Add a new provider key. Encrypts and persists. */
export function addProviderKey(
  provider: string,
  apiKey: string
): ProviderKeyInfo {
  // Remove existing key for this provider (one key per provider)
  cache.keys = cache.keys.filter((k) => k.provider !== provider)

  const now = new Date().toISOString()
  const stored: StoredKey = {
    id: nanoid(),
    provider,
    encryptedKey: encryptKey(apiKey),
    isValid: true,
    createdAt: now,
    updatedAt: now,
  }

  cache.keys.push(stored)
  persist()

  return {
    id: stored.id,
    provider: stored.provider,
    isValid: stored.isValid,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  }
}

/** Delete a provider key by ID. */
export function deleteProviderKey(id: string): boolean {
  const before = cache.keys.length
  cache.keys = cache.keys.filter((k) => k.id !== id)
  if (cache.keys.length < before) {
    persist()
    return true
  }
  return false
}

/** Get the decrypted API key for a provider. Used by the agent. */
export function getDecryptedKey(provider: string): string | null {
  const stored = cache.keys.find(
    (k) => k.provider === provider && k.isValid
  )
  if (!stored) return null
  try {
    return decryptKey(stored.encryptedKey)
  } catch (error) {
    log.error(`[provider-keys] Failed to decrypt key for ${provider}:`, error)
    return null
  }
}

// ── Key Validation ──────────────────────────────────────────────────────────

/** Validate an API key against its provider's API. */
export async function validateProviderKey(
  provider: string,
  apiKey: string
): Promise<boolean> {
  try {
    switch (provider) {
      case "openai":
        return await validateOpenAI(apiKey)
      case "anthropic":
        return await validateAnthropic(apiKey)
      case "google":
        return await validateGoogle(apiKey)
      default:
        return false
    }
  } catch (error) {
    log.error(`[provider-keys] Validation failed for ${provider}:`, error)
    return false
  }
}

async function validateOpenAI(apiKey: string): Promise<boolean> {
  const res = await fetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  return res.ok
}

async function validateAnthropic(apiKey: string): Promise<boolean> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20241022",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  })
  // 200 = valid, 401 = invalid, other errors (rate limit etc) = likely valid key
  return res.status !== 401
}

async function validateGoogle(apiKey: string): Promise<boolean> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  )
  return res.ok
}
