import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // These drive real processes through a real relay. Running the files against each other
    // starves them of CPU and turns waiting for a line into a timeout.
    fileParallelism: false,
    testTimeout: 40000,
    // The language comes from the environment, then from ~/.agenthop/install.json. Pin it, so a
    // machine where someone chose Chinese runs the same tests as everyone else.
    env: { AGENTHOP_LANG: "en" },
  },
});
