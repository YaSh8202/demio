import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter, Routes, Route } from "react-router-dom"

import "./index.css"
import App from "./App.tsx"
import { StreamPage } from "./pages/StreamPage.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <ThemeProvider>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/stream" element={<StreamPage />} />
        </Routes>
      </ThemeProvider>
    </HashRouter>
  </StrictMode>
)
