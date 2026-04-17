import type { ForgeConfig } from "@electron-forge/shared-types"
import { MakerSquirrel } from "@electron-forge/maker-squirrel"
import { MakerZIP } from "@electron-forge/maker-zip"
import { MakerDeb } from "@electron-forge/maker-deb"
import { VitePlugin } from "@electron-forge/plugin-vite"
import path from "path"

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Demio",
    executableName: "demio",
    icon: "./logos/icon",
    appBundleId: "com.demio.app",
    appCategoryType: "public.app-category.video",
    extraResource: [
      path.resolve("node_modules/agent-browser/bin"),
      path.resolve("node_modules/ffmpeg-static/ffmpeg"),
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "electron/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "electron/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
}

export default config
