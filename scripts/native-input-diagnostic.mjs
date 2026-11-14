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
  `input-diagnostic-native-${Date.now()}`,
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
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  const created = await command({
    type: "create",
    password: "isolated diagnostic password",
  });
  await command({ type: "confirmRecovery", key: created.recoveryKey });
  for (let i = 0; i < Number(process.env.DIAGNOSTIC_TASKS || 0); i++) {
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
  await page.reload();
  const cdp = await page.context().newCDPSession(page);
  const results = [];
  async function measure(label, target) {
    await target.focus();
    await page.evaluate(() => {
      window.__events = [];
      if (!window.__captureInput) {
        window.__captureInput = true;
        for (const type of ["keydown", "beforeinput", "input", "keyup"])
          document.addEventListener(
            type,
            (e) =>
              window.__events.push({
                type,
                time: performance.now(),
                delay: performance.now() - e.timeStamp,
              }),
            true,
          );
      }
    });
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    const start = performance.now();
    await page.keyboard.type("ab");
    const elapsed = performance.now() - start;
    const { profile: cpu } = await cdp.send("Profiler.stop");
    const events = await page.evaluate(() => window.__events);
    const row = { label, elapsed, events };
    results.push(row);
    await writeFile(
      path.join(profile, `${label}.cpu.json`),
      JSON.stringify(cpu),
    );
    console.log(
      label,
      Math.round(elapsed),
      events.map((e) => `${e.type}:${Math.round(e.delay)}`).join(" "),
    );
  }
  await page
    .getByRole("button", { name: /Новая запись/ })
    .first()
    .click();
  await measure("diary-title", page.locator(".title-input"));
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const dialog = page.locator(".task-dialog");
  const title = dialog.getByLabel("Название задачи");
  await measure("task-title", title);
  await measure("task-body", dialog.locator(".journal-prose"));
  await title.evaluate((e) => {
    e.spellcheck = false;
    e.autocomplete = "off";
  });
  await measure("task-title-no-spelling", title);
  await page.evaluate(() => document.documentElement.classList.add("opaque"));
  await measure("task-title-opaque", title);
  await dialog.evaluate((el) => {
    el.close();
    el.show();
  });
  await measure("task-title-nonmodal", title);
  await dialog.evaluate((el) => {
    el.close();
    el.showModal();
  });
  await measure("task-title-modal-again", title);
  await dialog.evaluate((el) => {
    const input = document.createElement("input");
    input.id = "diagnostic-plain";
    el.append(input);
  });
  await measure("plain-inside-modal", page.locator("#diagnostic-plain"));
  await page.evaluate(() => {
    window.__removedSelects = [...document.querySelectorAll("select")]
      .filter((e) => !e.closest(".task-dialog"))
      .map((e) => {
        const marker = document.createComment("select");
        e.replaceWith(marker);
        return { e, marker };
      });
  });
  await measure("title-without-board-selects", title);
  await page.evaluate(() =>
    window.__removedSelects.forEach(({ e, marker }) => marker.replaceWith(e)),
  );
  await measure("title-restored-board-selects", title);
  await page.screenshot({ path: path.join(profile, "diagnostic.png") });
  await writeFile(
    path.join(profile, "result.json"),
    JSON.stringify(
      { results, errors, version: await cdp.send("Browser.getVersion") },
      null,
      2,
    ),
  );
  console.log("Results:", profile);
} finally {
  await stop();
}
