import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `themes-native-${Date.now()}`);
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
  await writeFile(
    path.join(profile, "appearance.json"),
    JSON.stringify({ theme: "light" }),
  );
  await launch();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  assert.equal(
    await page
      .locator("html")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(238, 239, 243)",
  );
  await page.screenshot({ path: path.join(profile, "light-welcome.png") });
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native theme test password");
  await page.getByLabel("Повторите пароль").fill("native theme test password");
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
  let editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("NativeThemeMarker русский 🎈");
  await page.waitForTimeout(700);
  const entries = await command({
    type: "list",
    query: "",
    filter: "all",
    date: "",
    offset: 0,
  });
  const board = await command({ type: "planner" });
  await page
    .getByRole("button", { name: "Настройки", exact: true })
    .first()
    .click();
  await page.getByLabel("Тема", { exact: true }).selectOption("dark");
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Тема"]').disabled,
  );
  await page.screenshot({ path: path.join(profile, "dark-settings.png") });
  assert.equal(
    JSON.parse(await readFile(path.join(profile, "appearance.json"), "utf8"))
      .theme,
    "dark",
  );
  await page.getByLabel("Тема", { exact: true }).selectOption("light");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Тема"]').disabled,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  assert.equal(await editor.innerText(), "NativeThemeMarker русский 🎈");
  assert.deepEqual(
    await command({
      type: "list",
      query: "",
      filter: "all",
      date: "",
      offset: 0,
    }),
    entries,
  );
  assert.deepEqual(await command({ type: "planner" }), board);
  await stop();
  await launch();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await page.screenshot({ path: path.join(profile, "light-locked.png") });
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native theme test password");
  await page
    .getByRole("button", { name: "Открыть дневник", exact: true })
    .click();
  editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.waitFor();
  assert.equal(await editor.innerText(), "NativeThemeMarker русский 🎈");
  await page.screenshot({ path: path.join(profile, "light-journal.png") });
  await page
    .getByRole("button", { name: "Заблокировать", exact: true })
    .first()
    .click();
  await page.getByLabel("Пароль", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await stop();
  await writeFile(path.join(profile, "appearance.json"), "broken");
  await launch();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.deepEqual(await command({ type: "appearance" }), { theme: "dark" });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "report.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "light welcome before unlock",
          "settings and native theme switch",
          "appearance file only contains theme",
          "document revisions and planner unchanged",
          "restart and lock keep light theme",
          "corrupt appearance defaults dark",
        ],
        scale: await page.evaluate(() => devicePixelRatio),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`PASS native themes: ${profile}`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(profile, "failure.png") })
    .catch(() => {});
  console.error(profile);
  throw error;
} finally {
  await stop();
}
