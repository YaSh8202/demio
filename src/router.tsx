import { createHashRouter } from "react-router-dom"
import { RootLayout } from "@/layouts/root-layout"
import { DashboardPage } from "@/pages"
import { StreamPage } from "@/pages/stream"
import { ProjectPage } from "@/pages/projects/projectId"
import { ThreadPage } from "@/pages/projects/projectId/thread"

/**
 * Application router — all route definitions live here.
 *
 * Uses `createHashRouter` (required for Electron `file://` protocol).
 * The root layout wraps every route with shared providers (theme, tooltip).
 *
 * To add a new route:
 *   1. Create a page component in `src/pages/<path>/index.tsx`
 *   2. Add a `{ path, Component }` entry under `children` below
 */
export const router = createHashRouter([
  {
    Component: RootLayout,
    children: [
      { index: true, Component: DashboardPage },
      { path: "stream", Component: StreamPage },
      { path: "projects/:projectId", Component: ProjectPage },
      {
        path: "projects/:projectId/threads/:threadId",
        Component: ThreadPage,
      },
    ],
  },
])
