import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `task-links-native-${Date.now()}`);
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
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native link test password");
  await page.getByLabel("Повторите пароль").fill("native link test password");
  await page
    .getByRole("button", { name: "Создать дневник", exact: true })
    .click();
  const recovery = await page.locator(".recovery-code").innerText();
  await page.getByLabel("Введите сохранённый ключ для проверки").fill(recovery);
  await page
    .getByRole("button", { name: "Ключ сохранён — продолжить" })
    .click();
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  const editor = page.locator(".journal-prose").first();
  await editor.fill("NativeLinkedTaskMarker русский 🎈");
  await editor.press("Control+a");
  await editor.click({ button: "right" });
  await page.waitForFunction(() => window.__notNativeMenuProbe);
  const probe = await page.evaluate(() => window.__notNativeMenuProbe);
  assert.equal(probe.names[probe.insertedIndex - 1], "selectAll");
  assert.equal(probe.label, "Создать задачу");
  // CDP cannot select an OS menu command. Exercise the same JS bridge after
  // inspecting the actual WebView2 menu; physical menu activation is separate.
  const item = await page.evaluate(() => window.__notTaskMenu.prepare());
  await page.keyboard.press("Escape");
  await page.evaluate((token) => window.__notTaskMenu.run(token), item.token);
  await page.locator(".task-link-icon").waitFor();
  let board = await command({ type: "planner" });
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].title, "NativeLinkedTaskMarker русский 🎈");
  const links = await command({ type: "taskLinks" });
  assert.equal(links.length, 1);
  await page.locator(".task-link-icon").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Открыть фрагмент в дневнике" })
    .click();
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("task-link-icon"),
  );
  await editor.click();
  await editor.focus();
  await editor.press("Control+a");
  await editor.press("Backspace");
  const confirm = page.getByRole("dialog", {
    name: "Разорвать связь с задачей?",
    exact: true,
  });
  await confirm
    .getByRole("button", { name: "Разорвать связь", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector(".task-link-icon"));
  await editor.press("Control+z");
  await page.locator(".task-link-icon").waitFor();
  await page.waitForTimeout(850);
  assert.equal((await command({ type: "taskLinks" }))[0].active, true);
  await stop();
  await launch();
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native link test password");
  await page
    .getByRole("button", { name: "Открыть дневник", exact: true })
    .click();
  await page.locator(".task-link-icon").waitFor();
  assert.equal((await command({ type: "planner" })).tasks.length, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({path:path.join(profile,"linked-diary.png")});
  const result = {
    native: true,
    menu: probe,
    persisted: true,
    unlinkUndo: true,
    scale: await page.evaluate(() => devicePixelRatio),
    limitations: [
      "Physical OS menu activation, copy/cut/paste and Windows 100/150/200 percent remain manual checks",
    ],
  };
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ profile, ...result }, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(profile, "failure.png") })
    .catch(() => {});
  await writeFile(
    path.join(profile, "failure.json"),
    JSON.stringify(
      {
        errors,
        body: await page
          ?.locator("body")
          .innerText()
          .catch(() => ""),
        focus: await page
          ?.evaluate(() => document.activeElement?.outerHTML)
          .catch(() => ""),
      },
      null,
      2,
    ),
  );
  console.error(profile);
  throw error;
} finally {
  await stop();
}
