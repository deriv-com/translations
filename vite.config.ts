/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve, relative, extname } from "path";
import { fileURLToPath } from "node:url";
import dts from "vite-plugin-dts";
import { glob } from "glob";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, "./src/index.ts"),
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
      output: {
        assetFileNames: "assets/[name]",
        entryFileNames: "[name].js",
        globals: {
          react: "React",
        },
      },
      input: Object.fromEntries(
        glob
          .sync("src/**/*.{ts,tsx}", {
            ignore: [
              "**/*.test.ts",
              "**/*.css",
              "**/*.test.tsx",
              "**/*.spec.ts",
              "**/*.spec.tsx",
              "**/__tests__/**",
              "**/playground/*.tsx",
              "**/playground/*.ts",
              "**/playground/*.css",
              "setupTests.ts",
              "src/App.tsx",
              "src/main.tsx",
              "src/vite-env.d.ts",
            ],
          })
          .map((file) => {
            return [
              relative(
                "src",
                file.slice(0, file.length - extname(file).length)
              ),
              fileURLToPath(new URL(file, import.meta.url)),
            ];
          })
      ),
    },
  },

  plugins: [
    react(),
    dts({
      include: ["src"],
      exclude: [
        "setupTests.ts",
        "src/**/*.test.tsx",
        "src/**/*.test.ts",
        "src/playground/*.tsx",
        "src/playground/*.ts",
        "src/playground/*.css",
        "src/App.tsx",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@hooks": resolve(__dirname, "src/hooks"),
      "@utils": resolve(__dirname, "src/utils"),
      "@provider": resolve(__dirname, "src/provider"),
      "@components": resolve(__dirname, "src/components"),
      "@playground": resolve(__dirname, "src/playground"),
    },
  },

  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./setupTests.ts",
  },
});
