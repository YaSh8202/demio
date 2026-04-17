// ── Store IPC Handlers ───────────────────────────────────────────────────────
//
// IPC handler namespace for the file-based project store.
// Registered as `store` in allHandlers — renderer accesses via `apis.store.*`.
//
// Mutations broadcast events to all windows for multi-window sync.

import { BrowserWindow } from "electron"
import { DEMIO_EVENT_CHANNEL } from "../constants"
import type { NamespaceHandlers } from "../constants"
import {
  listProjects,
  createProject,
  getProject,
  updateProject,
  updateProjectMeta,
  deleteProjectFull,
  listThreads,
  createThread,
  getThread,
  updateThread,
  deleteThread,
  getMessages,
  appendMessage,
  updateMessage,
} from "../store"
import { generateProjectTitles } from "../agent/title-generator"
import log from "../lib/logger"
import type {
  StoredProject,
  StoredThread,
  UIMessage,
  ProjectMeta,
  GetMessagesOptions,
} from "../store"

// ── Broadcast helpers ────────────────────────────────────────────────────────

function broadcast(channel: string, ...args: unknown[]) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(DEMIO_EVENT_CHANNEL, channel, ...args)
    }
  })
}

function broadcastProjectsChanged() {
  broadcast("store:onProjectsChanged", listProjects())
}

function broadcastThreadsChanged(projectId: string) {
  broadcast("store:onThreadsChanged", projectId, listThreads(projectId))
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const storeHandlers = {
  // ── Projects ────────────────────────────────────────────────────────────

  listProjects: (_event: Electron.IpcMainInvokeEvent) => {
    return listProjects()
  },

  createProject: (
    _event: Electron.IpcMainInvokeEvent,
    name: string,
    model?: string
  ) => {
    const result = createProject(name, model)
    broadcastProjectsChanged()
    return result
  },

  getProject: (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    return getProject(projectId)
  },

  updateProject: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    updates: Partial<Pick<StoredProject, "name" | "lastThreadId">>
  ) => {
    const result = updateProject(projectId, updates)
    broadcastProjectsChanged()
    return result
  },

  updateProjectMeta: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    updates: Partial<Pick<ProjectMeta, "selectedModel">>
  ) => {
    return updateProjectMeta(projectId, updates)
  },

  deleteProject: (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    const result = deleteProjectFull(projectId)
    broadcastProjectsChanged()
    return result
  },

  // ── Threads ─────────────────────────────────────────────────────────────

  listThreads: (_event: Electron.IpcMainInvokeEvent, projectId: string) => {
    return listThreads(projectId)
  },

  createThread: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    title?: string
  ) => {
    const result = createThread(projectId, title)
    broadcastThreadsChanged(projectId)
    return result
  },

  getThread: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    return getThread(projectId, threadId)
  },

  updateThread: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    updates: Partial<Pick<StoredThread, "title" | "domain">>
  ) => {
    const result = updateThread(projectId, threadId, updates)
    broadcastThreadsChanged(projectId)
    return result
  },

  deleteThread: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string
  ) => {
    const result = deleteThread(projectId, threadId)
    broadcastThreadsChanged(projectId)
    return result
  },

  // ── Messages ────────────────────────────────────────────────────────────

  getMessages: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    opts?: GetMessagesOptions
  ) => {
    return getMessages(projectId, threadId, opts)
  },

  appendMessage: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    message: UIMessage
  ) => {
    const result = appendMessage(projectId, threadId, message)
    broadcast("store:onMessageAppended", projectId, threadId, result)
    // Also broadcast thread change since messageCount incremented
    broadcastThreadsChanged(projectId)
    return result
  },

  autoTitleFromPrompt: async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    text: string,
    modelId: string
  ) => {
    try {
      const { domain, projectTitle, threadTitle } = await generateProjectTitles(
        text,
        modelId
      )
      updateProject(projectId, { name: projectTitle })
      updateThread(projectId, threadId, { title: threadTitle, domain })
      broadcastProjectsChanged()
      broadcastThreadsChanged(projectId)
      return { domain, projectTitle, threadTitle }
    } catch (err) {
      log.error("[store] autoTitleFromPrompt failed:", err)
      return null
    }
  },

  updateMessage: (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string,
    threadId: string,
    messageId: string,
    updates: Partial<UIMessage>
  ) => {
    return updateMessage(projectId, threadId, messageId, updates)
  },
} satisfies NamespaceHandlers
