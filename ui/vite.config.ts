import { defineConfig } from "vite";
export default defineConfig({
  root: import.meta.dirname,
  base: "/ui/",
  build: { outDir: "../dist/ui", emptyOutDir: true },
});
