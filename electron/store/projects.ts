// ── Project Store ────────────────────────────────────────────────────────────
//
// Manages the global project index (projects.json) and per-project meta.json.
// The project index is cached in memory after first load.

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import log from "../lib/logger"
import type { StoredProject, ProjectIndex, ProjectMeta } from "./types"
import {
  projectIndexPath,
  projectDir,
  projectMetaPath,
  ensureDir,
  atomicWriteSync,
  storeRoot,
} from "./paths"

// ── In-memory cache ──────────────────────────────────────────────────────────

let cache: ProjectIndex | null = null

function emptyIndex(): ProjectIndex {
  return { version: 1, projects: [] }
}

// ── Read / Write ─────────────────────────────────────────────────────────────

function readIndex(): ProjectIndex {
  if (cache) return cache

  const filePath = projectIndexPath()
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    cache = JSON.parse(raw) as ProjectIndex
  } catch {
    cache = emptyIndex()
  }
  return cache
}

function writeIndex(index: ProjectIndex): void {
  cache = index
  const filePath = projectIndexPath()
  ensureDir(path.dirname(filePath))
  atomicWriteSync(filePath, JSON.stringify(index, null, 2))
}

function readMeta(projectId: string): ProjectMeta | null {
  try {
    const raw = fs.readFileSync(projectMetaPath(projectId), "utf-8")
    return JSON.parse(raw) as ProjectMeta
  } catch {
    return null
  }
}

function writeMeta(meta: ProjectMeta): void {
  const filePath = projectMetaPath(meta.id)
  ensureDir(path.dirname(filePath))
  atomicWriteSync(filePath, JSON.stringify(meta, null, 2))
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load the project index into memory. Call once on startup. */
export function initProjects(): void {
  readIndex()
}

/** List all projects (from cache). */
export function listProjects(): StoredProject[] {
  return readIndex().projects
}

/** Get a single project + its meta. */
export function getProject(
  projectId: string
): { project: StoredProject; meta: ProjectMeta } | null {
  const index = readIndex()
  const project = index.projects.find((p) => p.id === projectId)
  if (!project) return null

  const meta = readMeta(projectId) ?? {
    version: 1 as const,
    id: projectId,
    selectedModel: "",
  }

  return { project, meta }
}

/**
 * Create a new project.
 * Creates the project directory, meta.json, and adds to the index.
 * Does NOT create the default thread — that's handled by the store facade.
 */
export function createProject(
  name: string,
  model?: string,
  opts?: {
    domain?: string | null
    voiceId?: string | null
    voiceName?: string | null
  }
): StoredProject {
  const now = new Date().toISOString()
  const id = randomUUID()

  const project: StoredProject = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    lastThreadId: null,
    domain: opts?.domain ?? null,
  }

  const meta: ProjectMeta = {
    version: 1,
    id,
    selectedModel: model ?? "",
    voiceId: opts?.voiceId ?? null,
    voiceName: opts?.voiceName ?? null,
  }

  // Create project directory structure
  ensureDir(projectDir(id))

  // Write meta
  writeMeta(meta)

  // Add to index
  const index = readIndex()
  index.projects.unshift(project)
  writeIndex(index)

  return project
}

/**
 * Update a project's fields (name, lastThreadId).
 * Returns the updated project, or null if not found.
 */
export function updateProject(
  projectId: string,
  updates: Partial<Pick<StoredProject, "name" | "lastThreadId" | "domain">>
): StoredProject | null {
  const index = readIndex()
  const project = index.projects.find((p) => p.id === projectId)
  if (!project) return null

  if (updates.name !== undefined) project.name = updates.name
  if (updates.lastThreadId !== undefined)
    project.lastThreadId = updates.lastThreadId
  if (updates.domain !== undefined) project.domain = updates.domain
  project.updatedAt = new Date().toISOString()

  writeIndex(index)
  return project
}

/**
 * Update a project's meta (selectedModel, etc.).
 * Returns the updated meta, or null if project not found.
 */
export function updateProjectMeta(
  projectId: string,
  updates: Partial<Pick<ProjectMeta, "selectedModel" | "voiceId" | "voiceName">>
): ProjectMeta | null {
  const index = readIndex()
  const exists = index.projects.some((p) => p.id === projectId)
  if (!exists) return null

  const meta = readMeta(projectId) ?? {
    version: 1 as const,
    id: projectId,
    selectedModel: "",
  }

  if (updates.selectedModel !== undefined)
    meta.selectedModel = updates.selectedModel
  if (updates.voiceId !== undefined) meta.voiceId = updates.voiceId
  if (updates.voiceName !== undefined) meta.voiceName = updates.voiceName

  writeMeta(meta)
  return meta
}

/**
 * Delete a project and all its data (threads, messages, meta).
 * Returns true if deleted, false if not found.
 */
export function deleteProject(projectId: string): boolean {
  const index = readIndex()
  const idx = index.projects.findIndex((p) => p.id === projectId)
  if (idx === -1) return false

  index.projects.splice(idx, 1)
  writeIndex(index)

  // Remove project directory recursively
  const dir = projectDir(projectId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    log.error(`[store] Failed to remove project dir: ${dir}`)
  }

  return true
}

/** Reset the in-memory cache (used in tests or reload scenarios). */
export function resetProjectCache(): void {
  cache = null
}

/**
 * Ensure the store root directory exists.
 * Call once during initStore().
 */
export function ensureStoreRoot(): void {
  ensureDir(storeRoot())
}
