import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `pdf-080-native-${Date.now()}`);
await mkdir(profile, { recursive: true });
let child, browser, page;
const errors = [];
async function launch() {
  const env = {
    ...process.env,
    NOT_STUDIO_TEST_DATA_DIR: profile,
    NOT_STUDIO_TEST_PDF: path.join(profile, "document.pdf"),
  };
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
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  const created = await command({
    type: "create",
    password: "isolated PDF test password",
  });
  await command({ type: "confirmRecovery", key: created.recoveryKey });
  await page.reload();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.getByLabel("Название задачи").fill("Нативный PDF: текущие правки");
  const editor = page.locator(".journal-prose:visible");
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 500;
    canvas.height = 300;
    const context = canvas.getContext("2d");
    context.fillStyle = "#b4a7dd";
    context.fillRect(0, 0, 500, 300);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const attachment = await command({ type: "addPastedImage", data });
  await editor.evaluate((root, attachment) => {
    root.editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            attachmentId: attachment.id,
            name: "Native image",
            mime: attachment.mime,
            size: attachment.size,
            widthPercent: 35,
            layout: "right",
          },
        },
        ...Array.from({ length: 25 }, (_, i) => ({
          type: "paragraph",
          content: [
            {
              type: "text",
              text:
                `Нативный контроль ${i}. ` +
                "Сохранение текущего текста без создания задачи. ".repeat(8),
            },
          ],
        })),
      ],
    });
  }, attachment);
  const before = await editor.evaluate((root) =>
    JSON.stringify(root.editor.getJSON()),
  );
  await page.getByRole("button", { name: "Скачать PDF", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "PDF сохранён" })
    .waitFor({ timeout: 65000 });
  let pdf = await readFile(path.join(profile, "document.pdf"));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(
    await editor.evaluate((root) => JSON.stringify(root.editor.getJSON())),
    before,
  );
  const board = await command({ type: "planner" });
  assert.equal(board.tasks.length, 0, "Export must not save task");
  assert.equal(await page.locator("#not-pdf-document").count(), 0);
  await writeFile(path.join(profile, "task.pdf"), pdf);
  await page
    .locator(".task-dialog-footer")
    .getByRole("button", { name: "Отменить", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Удалить изменения", exact: true })
    .click();
  await page.getByRole("button", { name: "Дневник", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await page.getByLabel("Название записи").fill("PDF дневника");
  await page
    .locator(".journal-prose:visible")
    .fill("Текущий текст дневника в PDF.");
  await page.getByRole("button", { name: "Скачать PDF", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "PDF сохранён" })
    .waitFor({ timeout: 65000 });
  pdf = await readFile(path.join(profile, "document.pdf"));
  await writeFile(path.join(profile, "diary.pdf"), pdf);
  const operation = await command({
    type: "beginPdfExport",
    name: "cancelled",
  });
  await command({ type: "lock" });
  const stale = await command({ type: "printPdfExport", operation }).then(
    () => false,
    () => true,
  );
  assert.ok(stale, "Stale operation must fail after lock");
  assert.deepEqual(await readFile(path.join(profile, "document.pdf")), pdf);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify(
      {
        passed: true,
        bytes: pdf.length,
        tests: [
          "native task PDF",
          "unsaved edits",
          "no task creation",
          "editor unchanged",
          "lock invalidation",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, profile, bytes: pdf.length }));
} finally {
  await stop();
}
