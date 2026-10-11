import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  devToolbar: {
    enabled: false,
  },
  build: {
    // One page: its CSS rides in the document instead of costing a second request.
    inlineStylesheets: "always",
  },
});
