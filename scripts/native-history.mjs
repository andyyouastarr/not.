import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `history-native-${Date.now()}`);
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
  const password = "native history test password";
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
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  let dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  await dialog.getByLabel("Название задачи").fill("NativeHistorySecretMarker");
  const editor = dialog.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Описание истории 🎈");
  await dialog.getByRole("tab", { name: "История", exact: true }).click();
  await dialog.getByText("История появится после создания задачи").waitFor();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  let board = await command({ type: "planner" });
  const id = board.tasks[0].id;
  for (const stage of [
    board.stages[1].id,
    board.stages[0].id,
    board.stages[1].id,
    board.stages[2].id,
  ]) {
    board = await command({
      type: "plannerChange",
      change: {
        action: "move",
        id,
        revision: board.tasks[0].revision,
        stage,
        before: null,
      },
    });
  }
  const query = {
    taskId: id,
    from: null,
    to: null,
    assignee: { mode: "all" },
    kinds: [],
    cursor: null,
  };
  const journal = await command({ type: "taskHistory", query });
  assert.equal(journal.events.filter((e) => e.kind === "moved").length, 4);
  assert.equal(journal.events.filter((e) => e.kind === "created").length, 1);
  assert.equal(journal.events.filter((e) => e.kind === "completed").length, 1);
  await stop();
  await launch();
  dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Открыть дневник", exact: true })
    .click();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  assert.deepEqual(await command({ type: "taskHistory", query }), journal);
  await page.locator(".planner-card-open").click();
  await dialog.getByRole("tab", { name: "История", exact: true }).click();
  await dialog.locator(".history-stage").first().waitFor();
  assert.equal(await dialog.locator(".history-stage").count(), 4);
  assert.equal(await dialog.locator(".history-stage li").count(), 5);
  await page.screenshot({ path: path.join(profile, "history-dark.png") });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.waitForFunction(
    () =>
      getComputedStyle(document.getElementById("task-history-tab")).color ===
      "rgb(17, 17, 19)",
  );
  await page.screenshot({ path: path.join(profile, "history-light.png") });
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "vault-lock-request",
      payload: null,
    }),
  );
  await page.getByLabel("Пароль", { exact: true }).waitFor();
  assert.equal(await page.locator(".task-history").count(), 0);
  const bytes = await readFile(path.join(profile, "vault", "journal.db"));
  assert.equal(bytes.includes(Buffer.from("NativeHistorySecretMarker")), false);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify(
      { passed: true, eventCount: journal.events.length, errors },
      null,
      2,
    ),
  );
  console.log(`PASS native history: ${profile}`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(profile, "failure.png") })
    .catch(() => {});
  console.error(profile);
  throw error;
} finally {
  await stop();
}
