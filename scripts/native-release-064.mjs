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
  `release-064-native-${Date.now()}`,
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
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  const created = await command({
    type: "create",
    password: "isolated release test password",
  });
  await command({ type: "confirmRecovery", key: created.recoveryKey });
  await page.reload();
  await page
    .getByRole("button", { name: /Новая запись/ })
    .first()
    .click();
  assert.equal(
    await page.locator(".title-input").getAttribute("placeholder"),
    "Название",
  );
  const editor = page.locator(".journal-prose");
  await editor.fill("Native diary timestamp");
  await editor.press("Control+a");
  await editor.click({ button: "right" });
  await page.waitForFunction(
    () => window.__notNativeMenuProbe?.label === "Timestamp разделитель",
  );
  const diaryProbe = await page.evaluate(() => window.__notNativeMenuProbe);
  const menu = await page.evaluate(() => window.__notTaskMenu.prepare());
  assert.equal(menu.label, "Создать задачу");
  assert.equal(menu.additional[0].label, "Timestamp разделитель");
  assert.ok(diaryProbe.insertedIndex >= 1);
  await dismissNativeMenu();
  await page.evaluate(
    (token) => window.__notTaskMenu.run(token),
    menu.additional[0].token,
  );
  await editor.locator(".timestamp-divider").waitFor();
  await page.keyboard.type("After divider");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.getByLabel("Название задачи").fill("Native context trash");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  const card = page.locator(".planner-card");
  await card.waitFor();
  await page.evaluate(() => (window.__notNativeMenuProbe = null));
  await card.click({ button: "right" });
  await page.waitForFunction(
    () => window.__notNativeMenuProbe?.label === "В корзину",
  );
  const trashProbe = await page.evaluate(() => window.__notNativeMenuProbe);
  const item = await page.evaluate(() => window.__notTaskMenu.prepare());
  await dismissNativeMenu();
  await page.evaluate((token) => window.__notTaskMenu.run(token), item.token);
  await card.waitFor({ state: "detached" });
  const board = await command({ type: "planner" });
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].deleted, true);
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await card.waitFor();
  await page.screenshot({ path: path.join(profile, "trash.png") });
  await command({ type: "lock" });
  await command({
    type: "unlock",
    credential: "isolated release test password",
    recovery: false,
  });
  assert.equal((await command({ type: "planner" })).tasks.length, 1);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify({ passed: true, diaryProbe, trashProbe, errors }, null, 2),
  );
  console.log(`Native release check passed: ${profile}`);
} finally {
  await stop();
}
