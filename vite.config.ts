import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

// Standalone TanStack Start config. Plugin order matters: tsconfig paths and
// Tailwind first, then TanStack Start (which owns SSR + the server build),
// nitro for the deployable Node bundle, and the React plugin last.
export default defineConfig({
  server: { port: 8080 },
  resolve: {
    // Single React copy across react-query / react-router / react-dom.
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      // Redirect the bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
      // Fail the build if anything under src/server/** — or a `server-only`
      // import — is pulled into the client bundle. Keeps DB/RLS code server-side.
      importProtection: {
        behavior: "error",
        client: {
          files: ["**/server/**"],
          specifiers: ["server-only"],
        },
      },
    }),
    nitro({ preset: "node-server" }),
    viteReact(),
  ],
});
