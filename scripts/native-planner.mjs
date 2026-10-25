import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `planner-native-${Date.now()}`);
await mkdir(profile, { recursive: true });
if (process.env.NOT_STUDIO_TEST_THEME === "light")
  await writeFile(
    path.join(profile, "appearance.json"),
    JSON.stringify({ theme: "light" }),
  );
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
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native planner test password");
  await page
    .getByLabel("Повторите пароль")
    .fill("native planner test password");
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
  await dialog.getByLabel("Название задачи").fill("NativePlannerSecretMarker");
  await dialog.getByLabel("Дедлайн").fill("2020-01-01");
  const editor = dialog.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Русский текст 🎈 таблица и изображение");
  await editor.press("Control+End");
  await editor.press("Enter");
  await dialog.getByRole("button", { name: "Чек-лист", exact: true }).click();
  await page.keyboard.insertText("Пункт задачи");
  await editor.getByRole("checkbox").check();
  await editor.press("Control+End");
  await editor.press("Enter");
  await editor.press("Enter");
  await dialog
    .getByRole("button", { name: "Добавить блок", exact: true })
    .click();
  await dialog
    .getByRole("menuitem", { name: "Таблица 3 × 3", exact: true })
    .click();
  await editor.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    canvas.getContext("2d").fillRect(0, 0, 120, 90);
    const blob = await new Promise((r) => canvas.toBlob(r));
    const data = new DataTransfer();
    data.items.add(new File([blob], "fixture.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  // Save while the image import can still be pending.
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  let state = await command({ type: "planner" });
  assert.equal(state.tasks.length, 1);
  const taskId = state.tasks[0].id;
  assert.match(JSON.stringify(state.tasks[0].document), /attachmentId/);
  assert.match(JSON.stringify(state.tasks[0].document), /"checked":true/);
  // Locking before drop must cancel the gesture without sending a move.
  {
    const source = await page.locator(".planner-card").boundingBox();
    await page.mouse.move(source.x + 35, source.y + 25);
    await page.mouse.down();
    await page.mouse.move(source.x + 60, source.y + 40, { steps: 5 });
    await page.locator(".task-drag-overlay").waitFor();
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "vault-lock-request",
        payload: null,
      }),
    );
    await page.getByRole("heading", { name: "С возвращением." }).waitFor();
    await page.mouse.up();
    assert.equal(await page.locator(".task-drag-overlay").count(), 0);
    await page
      .getByLabel("Пароль", { exact: true })
      .fill("native planner test password");
    await page
      .getByRole("button", { name: "Открыть дневник", exact: true })
      .click();
    await page.getByRole("button", { name: "Планер", exact: true }).click();
    await page.locator(".planner-card").waitFor();
    const afterLock = await command({ type: "planner" });
    assert.equal(afterLock.tasks[0].revision, state.tasks[0].revision);
    assert.equal(afterLock.tasks[0].stageId, null);
  }
  const card = page.locator(".planner-card");
  const from = await card.boundingBox();
  const to = await page
    .getByRole("region", { name: "В работе", exact: true })
    .locator(".kanban-cards")
    .boundingBox();
  await page.mouse.move(from.x + 35, from.y + 25);
  await page.mouse.down();
  await page.mouse.move(from.x + 45, from.y + 25, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 20 });
  await page.locator(".task-drag-overlay").waitFor();
  await page.screenshot({ path: "artifacts/planner-pointer-drag.png" });
  await page.mouse.up();
  await page
    .getByRole("region", { name: "В работе", exact: true })
    .locator(".planner-card")
    .waitFor();
  await page.screenshot({ path: "artifacts/planner-native-board.png" });
  // A rejected native move must keep the original card and show a real error.
  state = await command({ type: "planner" });
  await command({
    type: "plannerChange",
    change: {
      action: "move",
      id: taskId,
      revision: state.tasks[0].revision,
      stage: state.tasks[0].stageId,
      before: null,
    },
  });
  await card.locator("summary").click();
  await card
    .getByLabel("Стадия: NativePlannerSecretMarker")
    .selectOption({ label: "Готово" });
  await page
    .getByRole("alert")
    .filter({ hasText: "Задача изменилась" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("region", { name: "В работе", exact: true })
      .locator(".planner-card")
      .count(),
    1,
  );
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Дневник", exact: true }).click();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await card.waitFor();
  await card.locator(".planner-card-open").click();
  assert.equal(
    await editor
      .locator("img")
      .evaluate((img) => img.complete && img.naturalWidth === 120),
    true,
  );
  await dialog.getByLabel("Название задачи").fill("UnsavedPlannerDraftMarker");
  await dialog.getByText("Черновик сохранён", { exact: true }).waitFor();
  await page.screenshot({ path: "artifacts/planner-native-editor.png" });
  await stop();
  await launch();
  dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native planner test password");
  await page
    .getByRole("button", { name: "Открыть дневник", exact: true })
    .click();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Продолжить черновик", exact: true })
    .click();
  assert.equal(
    await dialog.getByLabel("Название задачи").inputValue(),
    "UnsavedPlannerDraftMarker",
  );
  // Simulate the same lock request emitted by Windows session/idle integration.
  await dialog.getByLabel("Название задачи").fill("FreshLockDraftMarker");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "vault-lock-request",
      payload: null,
    }),
  );
  await page.getByRole("heading", { name: "С возвращением." }).waitFor();
  assert.equal(await page.locator(".tiptap").count(), 0);
  await command({ type: "unlock", credential: recovery, recovery: true });
  state = await command({ type: "planner" });
  assert.equal(state.draft.title, "FreshLockDraftMarker");
  assert.equal(
    state.tasks.find((t) => t.id === taskId).title,
    "NativePlannerSecretMarker",
  );
  const bytes = await readFile(path.join(profile, "vault/journal.db"));
  assert.equal(bytes.includes(Buffer.from("NativePlannerSecretMarker")), false);
  assert.equal(bytes.includes(Buffer.from("UnsavedPlannerDraftMarker")), false);
  assert.equal(bytes.includes(Buffer.from("FreshLockDraftMarker")), false);
  assert.deepEqual(errors, []);
  await writeFile(
    "artifacts/native-planner.json",
    JSON.stringify(
      {
        passed: true,
        profile,
        testedAt: new Date().toISOString(),
        viewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          scale: devicePixelRatio,
        })),
        checks: [
          "real encrypted task and rich document",
          "save waits image import",
          "drag stage persisted",
          "pointer mouse down-move-up transfer",
          "lock before drop cancels without changing revision",
          "stale move rejected without moving card",
          "lock flushes fresh edit before debounce",
          "draft survives forced restart",
          "lock clears editor",
          "recovery key unchanged",
          "saved task unchanged by draft",
          "no plaintext markers",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Native planner checks passed");
} catch (e) {
  await page
    ?.screenshot({ path: "artifacts/planner-native-failure.png" })
    .catch(() => {});
  throw e;
} finally {
  await stop();
}
