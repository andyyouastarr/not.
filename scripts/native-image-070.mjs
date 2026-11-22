import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `image-070-native-${Date.now()}`);
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
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  const created = await command({
    type: "create",
    password: "isolated image test password",
  });
  await command({ type: "confirmRecovery", key: created.recoveryKey });
  await page.reload();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.getByLabel("Название задачи").fill("Native image interaction");
  const editor = page.locator(".journal-prose:visible");
  await editor.click();
  await editor.evaluate(async (root) => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 200;
    const context = canvas.getContext("2d");
    context.fillStyle = "#b6a3df";
    context.fillRect(0, 0, 400, 200);
    const blob = await new Promise((r) => canvas.toBlob(r));
    const data = new DataTransfer();
    data.items.add(new File([blob], "native.png", { type: "image/png" }));
    root.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await editor.locator("img").waitFor();
  await editor.evaluate((root) => {
    const e = root.editor;
    const image = structuredClone(
      e.getJSON().content.find((n) => n.type === "image"),
    );
    image.attrs.widthPercent = 35;
    image.attrs.layout = "left";
    e.commands.setContent({
      type: "doc",
      content: [
        image,
        ...Array.from({ length: 8 }, (_, i) => ({
          type: "paragraph",
          content: [
            {
              type: "text",
              text:
                `Paragraph ${i + 1}. ` +
                "Text flows around the image. ".repeat(8),
            },
          ],
        })),
      ],
    });
  });
  await page.waitForFunction(
    () => document.querySelector(".node-image")?.dataset.imageLayout === "left",
  );
  const before = await editor.evaluate((root) =>
    JSON.stringify(root.editor.getJSON()),
  );
  const image = editor.locator(".node-image img");
  const source = await image.boundingBox();
  const canvas = await editor.boundingBox();
  const target = await editor.locator("p").nth(1).boundingBox();
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width - 20, target.y + 5, {
    steps: 12,
  });
  await editor.locator(".image-preview").waitFor();
  assert.equal(
    await editor.evaluate((root) => JSON.stringify(root.editor.getJSON())),
    before,
  );
  await page.mouse.up();
  assert.equal(
    await editor.locator(".node-image").getAttribute("data-image-layout"),
    "right",
  );
  const after = await editor.evaluate((root) =>
    JSON.stringify(root.editor.getJSON()),
  );
  await page.keyboard.press("Control+z");
  assert.equal(
    await editor.evaluate((root) => JSON.stringify(root.editor.getJSON())),
    before,
  );
  await page.keyboard.press("Control+Shift+z");
  assert.equal(
    await editor.evaluate((root) => JSON.stringify(root.editor.getJSON())),
    after,
  );
  await page.screenshot({ path: path.join(profile, "task-image.png") });
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.locator(".planner-card").waitFor();
  const saved = (await command({ type: "planner" })).tasks[0];
  assert.deepEqual(saved.document, JSON.parse(after));
  await stop();
  await launch();
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  await command({
    type: "unlock",
    credential: "isolated image test password",
    recovery: false,
  });
  const reopened = (await command({ type: "planner" })).tasks[0];
  assert.deepEqual(reopened.document, saved.document);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify(
      {
        passed: true,
        errors,
        checks: [
          "pointer task move",
          "preview unchanged document",
          "undo redo",
          "encrypted save",
          "restart",
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Native image task passed: ${profile}`);
} finally {
  await stop();
}
