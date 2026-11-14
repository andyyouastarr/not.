import { chromium } from "playwright";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(
  root,
  "artifacts",
  `title-performance-native-${Date.now()}`,
);
await mkdir(profile, { recursive: true });
let child, browser, page;
const errors = [];
async function launch() {
  const env = { ...process.env, NOT_STUDIO_TEST_DATA_DIR: profile };
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  child = spawn(path.join(root, "src-tauri/target/debug/not-studio.exe"), [], {
    cwd: root,
    env,
    windowsHide: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  for (let i = 0; i < 80; i++) {
    try {
      const port = (
        await readFile(
          path.join(profile, "webview/EBWebView/DevToolsActivePort"),
          "utf8",
        )
      ).split(/\r?\n/)[0];
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = browser.contexts()[0].pages()[0];
      if (!page) throw Error("WebView not ready");
      page.on("pageerror", (e) => errors.push(e.message));
      await page.waitForLoadState("domcontentloaded");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw Error("Native planner launch failed");
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((r) => child.once("exit", r));
    child.kill();
    await exit;
  }
  await browser?.close().catch(() => {});
}
const command = (request) =>
  page.evaluate(
    (request) => window.__TAURI_INTERNALS__.invoke("dispatch", { request }),
    request,
  );
try {
  await launch();
  const password = "native timestamp password";
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByLabel("Повторите пароль").fill(password);
  await page
    .getByRole("button", { name: "Создать дневник", exact: true })
    .click();
  const recovery = await page.locator(".recovery-code").innerText();
  await page.getByLabel("Введите сохранённый ключ для проверки").fill(recovery);
  await page
    .getByRole("button", { name: "Ключ сохранён — продолжить" })
    .click();
  for (let i = 0; i < 90; i++) {
    await command({
      type: "plannerChange",
      change: {
        action: "save",
        draft: {
          id: crypto.randomUUID(),
          revision: 0,
          title: `Synthetic task ${i}`,
          assigneeId: null,
          deadline: null,
          document: {
            type: "doc",
            content: Array.from({ length: 20 }, () => ({
              type: "paragraph",
              content: [
                { type: "text", text: "Synthetic content ".repeat(80) },
              ],
            })),
          },
        },
      },
    });
  }
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  const title = dialog.getByLabel("Название задачи");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(500);
  await title.evaluate((input) => {
    const samples = [];
    window.__typingSamples = samples;
    input.addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() => samples.push(performance.now() - start));
    });
  });
  await title.pressSequentially("Sample", {
    delay: 40,
    timeout: 120000,
  });
  await dialog.getByText("Черновик сохранён", { exact: true }).waitFor();
  const board = await command({ type: "planner" });
  assert.equal(board.tasks.length, 90);
  assert.equal(board.draft.title, "Sample");
  const keyChecks = [];
  for (const opaque of [false, true]) {
    await page.evaluate(
      (opaque) => document.documentElement.classList.toggle("opaque", opaque),
      opaque,
    );
    for (const plain of [false, true]) {
      if (plain)
        await dialog.evaluate((root) => {
          const input = document.createElement("input");
          input.id = "plain-test-input";
          root.append(input);
          input.focus();
        });
      else await title.focus();
      const start = performance.now();
      await page.keyboard.type("abc");
      keyChecks.push({ opaque, plain, elapsed: performance.now() - start });
      console.log("Native key check", keyChecks.at(-1));
      if (plain)
        await page.locator("#plain-test-input").evaluate((el) => el.remove());
    }
  }
  const samples = await page.evaluate(() => window.__typingSamples);
  const draft = board.draft;
  const timings = {};
  for (const type of ["plannerChange", "savePlannerDraft"]) {
    timings[type] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = await command(
        type === "plannerChange"
          ? { type, change: { action: "draft", draft } }
          : { type, draft },
      );
      timings[type].push({
        ms: performance.now() - start,
        responseBytes: JSON.stringify(result).length,
      });
    }
  }
  await page.screenshot({ path: path.join(profile, "title.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify(
      {
        passed: true,
        keyChecks,
        tasks: 90,
        samples,
        maxInputToFrameMs: Math.max(...samples),
        timings,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Native title performance passed: ${profile}`);
} finally {
  await stop();
}
