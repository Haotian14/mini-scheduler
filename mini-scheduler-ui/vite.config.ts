import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// A GitHub Pages project site is served from /<repo>/, so the asset paths have
// to be prefixed. BASE_PATH is set by the Pages workflow and defaults to the
// root for local development and any other host.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [vue()],
});
