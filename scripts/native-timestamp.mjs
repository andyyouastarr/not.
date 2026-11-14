import { chromium } from "playwright";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `timestamp-native-${Date.now()}`);
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
// CDP Escape bypasses the Windows popup. Cancel only this test process menu.
async function dismissNativeMenu() {
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class TestMenu { public delegate bool Callback(IntPtr h, IntPtr p); [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Callback c, IntPtr p); public static void Cancel(IntPtr h) { SendMessage(h,31,IntPtr.Zero,IntPtr.Zero); EnumChildWindows(h,(c,p)=>{SendMessage(c,31,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero); } }'; $targetWindow=(Get-Process -Id ${child.pid}).MainWindowHandle; [TestMenu]::Cancel($targetWindow)`;
  await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    { windowsHide: true },
  );
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
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  let dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  await dialog
    .getByLabel("Название задачи")
    .fill("NativeTimestampSecretMarker");
  let editor = dialog.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("До даты");
  await editor.click({ button: "right" });
  await page.waitForFunction(
    () => window.__notNativeMenuProbe?.label === "Timestamp разделитель",
  );
  const probe = await page.evaluate(() => window.__notNativeMenuProbe);
  assert.equal(probe.names[probe.insertedIndex - 1], "selectAll");
  assert(probe.names.includes("copy") && probe.names.includes("paste"));
  const item = await page.evaluate(() => window.__notTaskMenu.prepare());
  await dismissNativeMenu();
  await page.evaluate((token) => window.__notTaskMenu.run(token), item.token);
  await editor.locator(".timestamp-divider").waitFor();
  const date = await editor
    .locator(".timestamp-divider")
    .getAttribute("data-timestamp-date");
  await page.keyboard.type("After timestamp");
  assert.equal(await editor.locator("p").last().innerText(), "After timestamp");
  await dialog.getByText("Черновик сохранён", { exact: true }).waitFor();
  let board = await command({ type: "planner" });
  assert.equal(board.draft.document.content[1].attrs.date, date);
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await stop();
  await launch();
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Открыть дневник", exact: true })
    .click();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  board = await command({ type: "planner" });
  assert.equal(board.tasks[0].document.content[1].attrs.date, date);
  await page.locator(".planner-card-open").click();
  dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  editor = dialog.getByRole("textbox", { name: "Текст записи" });
  assert.equal(
    await editor.locator(".timestamp-divider").innerText(),
    date.split("-").reverse().join("."),
  );
  await page.screenshot({ path: path.join(profile, "timestamp.png") });
  // Native keyboard context menu uses the caret even if the pointer is elsewhere.
  await editor.click();
  await editor.press("Control+End");
  await page.evaluate(() => (window.__notNativeMenuProbe = null));
  await editor.press("Shift+F10");
  await page.waitForFunction(
    () => window.__notNativeMenuProbe?.label === "Timestamp разделитель",
  );
  const keyboardItem = await page.evaluate(() =>
    window.__notTaskMenu.prepare(),
  );
  await dismissNativeMenu();
  await page.evaluate(
    (token) => window.__notTaskMenu.run(token),
    keyboardItem.token,
  );
  assert.equal(await editor.locator(".timestamp-divider").count(), 2);
  await editor.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    canvas.getContext("2d").fillRect(0, 0, 120, 90);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const data = new DataTransfer();
    data.items.add(new File([blob], "timestamp.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await editor.locator("img").waitFor();
  await dialog.getByText("Черновик сохранён", { exact: true }).waitFor();
  await page.evaluate(() => (window.__notNativeMenuProbe = null));
  await editor.locator("img").click({ button: "right" });
  await page.waitForFunction(
    () => window.__notNativeMenuProbe?.label === "Timestamp разделитель",
  );
  const imageItem = await page.evaluate(() => window.__notTaskMenu.prepare());
  await dismissNativeMenu();
  await page.evaluate(
    (token) => window.__notTaskMenu.run(token),
    imageItem.token,
  );
  assert.equal(await editor.locator(".timestamp-divider").count(), 3);
  const blocks = await editor.evaluate((root) =>
    root.editor.getJSON().content.map((n) => n.type),
  );
  assert.equal(blocks[blocks.indexOf("image") + 1], "timestampDivider");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "vault-lock-request",
      payload: null,
    }),
  );
  await page.getByLabel("Пароль", { exact: true }).waitFor();
  assert.equal(await page.locator(".timestamp-divider").count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify(
      {
        passed: true,
        date,
        probe,
        scale: await page.evaluate(() => devicePixelRatio),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`PASS native timestamp: ${profile}`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(profile, "failure.png") })
    .catch(() => {});
  console.error(profile);
  throw error;
} finally {
  await stop();
}
