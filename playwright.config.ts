import { defineConfig } from "@playwright/test";
const port = Number(process.env.PLAYWRIGHT_PORT || 1420);
export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 840 },
    headless: true,
    channel: "msedge",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
  },
});
