import { Outlet } from "react-router-dom"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"

export function RootLayout() {
  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </ThemeProvider>
  )
}
