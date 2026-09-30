import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

/** Dev only — production serves `web/dist` from Express on one port. */
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173)

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind every interface: the IPv6-only default makes the app unreachable
    // for clients that resolve localhost to 127.0.0.1.
    host: true,
    port: WEB_PORT,
    // No strictPort: a busy dev port should roll to the next one rather than
    // crash. Vite prints the URL it actually bound.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: true,
    port: WEB_PORT,
  },
})
