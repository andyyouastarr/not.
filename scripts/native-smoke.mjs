import { chromium } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `native-test-${Date.now()}`);
await mkdir(profile, { recursive: true });
const exe = path.join(root, "src-tauri/target/debug/not-studio.exe");
const imageFixture = process.env.NOT_STUDIO_TEST_ATTACHMENT;
const keyboardTest = process.env.NOT_STUDIO_TEST_KEYBOARD === "1";
const linkTest = process.env.NOT_STUDIO_TEST_LINK === "1";
const pasteIdleTest = process.env.NOT_STUDIO_TEST_PASTE_IDLE === "1";
const pasteRaceTest = process.env.NOT_STUDIO_TEST_PASTE_RACE === "1";
let clipboardHelper,
  pastedImageCount = 0;
async function waitClipboard(message) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error("Clipboard helper timeout"));
    }, 10000);
    const data = (chunk) => {
      if (chunk.toString().includes(message)) {
        cleanup();
        resolve();
      }
    };
    const exited = () => {
      cleanup();
      reject(Error("Clipboard helper stopped"));
    };
    function cleanup() {
      clearTimeout(timeout);
      clipboardHelper.stdout.off("data", data);
      clipboardHelper.off("exit", exited);
    }
    clipboardHelper.stdout.on("data", data);
    clipboardHelper.once("exit", exited);
  });
}
let linkServer, linkUrl, linkVisited, linkTimer;
const keyboardTimings = [];
let expectedTitle = "Проверка нативного дневника";
let savedImageWidth;
let child,
  activePage,
  diagnostic = "";
async function launch() {
  const env = { ...process.env, NOT_STUDIO_TEST_DATA_DIR: profile };
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  child = spawn(exe, [], { cwd: root, windowsHide: true, env });
  diagnostic = "";
  child.stdout.on("data", (b) => {
    diagnostic += b.toString();
  });
  child.stderr.on("data", (b) => {
    diagnostic += b.toString();
  });
  let browser;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null)
      throw Error(
        `Native process exited ${child.exitCode}: ${diagnostic.slice(-3000)}`,
      );
    try {
      const port = (
        await readFile(
          path.join(profile, "webview", "EBWebView", "DevToolsActivePort"),
          "utf8",
        )
      ).split("\n")[0];
      browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${Number(port)}`,
      );
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser)
    throw Error("Native WebView did not start: " + diagnostic.slice(-3000));
  let page;
  for (let i = 0; i < 60; i++) {
    page = browser
      .contexts()[0]
      ?.pages()
      .find((p) => !p.url().startsWith("devtools:"));
    if (page && page.url() !== "about:blank") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw Error("Native page not available");
  activePage = page;
  return { browser, page };
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await stopped;
  }
}
try {
  if (linkTest) {
    const route = `/not-link-test-${randomUUID()}`;
    let visited;
    linkVisited = new Promise((resolve) => {
      visited = resolve;
    });
    linkServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>not. studio link test</title><p>Link opened successfully. This test tab can be closed.</p>",
      );
      if (req.url === route) visited(true);
    });
    await new Promise((resolve) => linkServer.listen(0, "127.0.0.1", resolve));
    linkUrl = `http://127.0.0.1:${linkServer.address().port}${route}`;
  }
  let { browser, page } = await launch();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("heading", { name: "Создать дневник", exact: true })
    .waitFor();
  await page.screenshot({ path: "artifacts/native-welcome.png" });
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native smoke test password");
  await page.getByLabel("Повторите пароль").fill("native smoke test password");
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
  await page.getByLabel("Название записи").fill("Проверка нативного дневника");
  await page
    .getByRole("textbox", { name: "Текст записи" })
    .fill("КонтрольныйЗакрытыйТекст 🎈 Сохранность после перезапуска.");
  await page.getByRole("button", { name: "Сохранено", exact: true }).waitFor();
  if (linkTest) {
    await page
      .locator(".tiptap > p")
      .first()
      .evaluate((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    await page.getByRole("button", { name: "Ссылка", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Ссылка", exact: true })
      .fill(linkUrl);
    await page
      .locator(".link-menu")
      .getByRole("button", { name: "Добавить", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Сохранено", exact: true })
      .waitFor();
  }
  const checklistEditor = page.getByRole("textbox", { name: "Текст записи" });
  await checklistEditor.click();
  await checklistEditor.press("Control+End");
  await checklistEditor.press("Enter");
  await page.getByRole("button", { name: "Чек-лист", exact: true }).click();
  await page.keyboard.insertText("Проверить чек-лист");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Следующий пункт");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await checklistEditor
    .getByRole("checkbox", {
      name: "Пункт чек-листа: Проверить чек-лист",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Сохранено", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Добавить блок", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Таблица 3 × 3" }).click();
  await page.getByRole("button", { name: "Сохранено", exact: true }).waitFor();
  if (pasteRaceTest) {
    await page.evaluate(async () => {
      const original = window.createImageBitmap.bind(window);
      window.createImageBitmap = (...args) =>
        new Promise((resolve) => {
          window.resumePasteTest = () => {
            window.createImageBitmap = original;
            resolve(original(...args));
          };
        });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 10;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      const data = new DataTransfer();
      data.items.add(new File([blob], "delayed.png", { type: "image/png" }));
      document
        .querySelector(".tiptap")
        .dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          }),
        );
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "vault-lock-request",
        payload: null,
      });
      await window.__TAURI_INTERNALS__.invoke("dispatch", {
        request: { type: "lock" },
      });
    });
    await page
      .getByLabel("Пароль", { exact: true })
      .fill("native smoke test password");
    await page
      .getByRole("button", { name: "Открыть дневник", exact: true })
      .click();
    await page.getByLabel("Название записи").waitFor();
    await page.evaluate(() => window.resumePasteTest());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(
      await page.locator(".tiptap").count(),
      1,
      "Late lock callback must not lock the new session",
    );
    assert.equal(
      await page.locator(".node-image").count(),
      0,
      "Cancelled image must not enter the reopened diary",
    );
  }
  if (imageFixture) {
    await page
      .getByRole("button", { name: "Новая запись", exact: true })
      .first()
      .click();
    expectedTitle = "Изображение целиком и текст рядом";
    await page.getByLabel("Название записи").fill(expectedTitle);
    await page
      .getByRole("textbox", { name: "Текст записи" })
      .fill("КонтрольныйЗакрытыйТекст — перед картинкой.");
    await page
      .getByRole("textbox", { name: "Текст записи" })
      .press("Control+End");
    await page
      .getByRole("button", { name: "Фото или файл", exact: true })
      .click();
    const picture = page.locator(".node-image img");
    await picture.waitFor();
    await picture.evaluate(async (img) => {
      await img.decode();
      if (img.naturalWidth !== 900 || img.naturalHeight !== 600)
        throw Error("Incomplete image dimensions");
    });
    await page
      .getByRole("button", { name: "Сохранено", exact: true })
      .waitFor();
    const data = await page.evaluate(async (title) => {
      const invoke = (request) =>
        window.__TAURI_INTERNALS__.invoke("dispatch", { request });
      const rows = await invoke({
        type: "list",
        query: title,
        filter: "all",
        date: "",
        offset: 0,
      });
      const entry = await invoke({ type: "get", id: rows[0].id });
      const image = entry.document.content.find((n) => n.type === "image");
      return (
        await invoke({ type: "readAttachment", id: image.attrs.attachmentId })
      ).data;
    }, expectedTitle);
    assert.equal(
      createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
      createHash("sha256")
        .update(await readFile(imageFixture))
        .digest("hex"),
    );
    const bottom = await picture.evaluate((img) => {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 600;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(880, 580, 1, 1).data);
    });
    assert(
      bottom[1] > 150 && bottom[0] < 100,
      "Bottom of image must be decoded, not a partial preview",
    );
    await picture.scrollIntoViewIfNeeded();
    await picture.hover();
    const before = await picture.boundingBox();
    const handle = page.getByRole("slider", {
      name: "Размер картинки — правый угол",
    });
    const bounds = await handle.boundingBox();
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2 - before.width * 0.55,
      bounds.y + bounds.height / 2,
      { steps: 12 },
    );
    await page.mouse.up();
    await page.keyboard.insertText("Текст справа от изображения. ".repeat(8));
    const resized = await picture.boundingBox();
    assert(
      resized.width < before.width * 0.6 && resized.width > before.width * 0.3,
    );
    assert(Math.abs(resized.width / resized.height - 1.5) < 0.02);
    assert.equal(
      await page.locator(".node-image").getAttribute("data-image-layout"),
      "left",
    );
    // Drag the image to the right side of its following paragraph.
    const paragraph = page.locator(".node-image + p");
    await paragraph.scrollIntoViewIfNeeded();
    const target = await paragraph.boundingBox();
    await picture.dragTo(paragraph, {
      targetPosition: { x: target.width - 15, y: 12 },
    });
    assert.equal(
      await page.locator(".node-image").getAttribute("data-image-layout"),
      "right",
    );
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    assert.equal(
      await page.locator(".node-image").getAttribute("data-image-layout"),
      "left",
    );
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    assert.equal(
      await page.locator(".node-image").getAttribute("data-image-layout"),
      "right",
    );
    const geometry = await page.locator(".node-image + p").evaluate((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      const text = range.getClientRects()[0];
      const image = p.previousElementSibling.getBoundingClientRect();
      return {
        textRight: text.right,
        textTop: text.top,
        imageLeft: image.left,
        imageBottom: image.bottom,
      };
    });
    assert(
      geometry.textRight <= geometry.imageLeft &&
        geometry.textTop < geometry.imageBottom,
      "Text must flow beside the image",
    );
    savedImageWidth = await page
      .locator(".node-image")
      .evaluate((e) => e.style.width);
    await page
      .getByRole("button", { name: "Сохранено", exact: true })
      .waitFor();
    await page.screenshot({ path: "artifacts/native-image-layout.png" });
  }
  if (keyboardTest) {
    const editor = page.getByRole("textbox", { name: "Текст записи" });
    await editor.press("Control+End");
    await page
      .getByRole("button", { name: "Клавиатура-подсказка", exact: true })
      .click();
    assert(await editor.evaluate((e) => e === document.activeElement));
    await page.evaluate(() => {
      window.__keyboardChanges = [];
      new MutationObserver(() =>
        window.__keyboardChanges.push({
          label: document.querySelector(".keyboard-layout").textContent,
          at: Date.now(),
        }),
      ).observe(document.querySelector(".keyboard-layout"), {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    for (const [id, label] of [
      ["04090409", "ENG · US"],
      ["04190419", "РУС"],
      ["04090409", "ENG · US"],
      ["04190419", "РУС"],
    ]) {
      const { stdout } = await promisify(execFile)(
        "python",
        ["scripts/keyboard-native.py", String(child.pid), id],
        { windowsHide: true },
      );
      const requested = JSON.parse(stdout);
      await page.waitForFunction(
        (text) =>
          document.querySelector(".keyboard-layout")?.textContent === text,
        label,
      );
      const changes = await page.evaluate(() => window.__keyboardChanges);
      const observed = changes.findLast(
        (change) =>
          change.label === label && change.at >= requested.requestedAt,
      );
      if (observed) keyboardTimings.push(observed.at - requested.requestedAt);
      await page.screenshot({ path: `artifacts/native-keyboard-${id}.png` });
    }
    assert(keyboardTimings.length >= 3);
    assert(
      Math.max(...keyboardTimings) < 350,
      "Layout updates should remain responsive",
    );
    const resize = page.getByRole("separator", { name: "Высота клавиатуры" });
    await resize.focus();
    await resize.press("ArrowUp");
    await page.waitForFunction(
      async () =>
        (
          await window.__TAURI_INTERNALS__.invoke("dispatch", {
            request: { type: "settings" },
          })
        ).keyboardHeight === 200,
    );
    const width = page.getByRole("separator", { name: "Ширина клавиатуры" });
    await width.focus();
    await width.press("Home");
    await width.press("ArrowRight");
    await page.waitForFunction(
      async () =>
        (
          await window.__TAURI_INTERNALS__.invoke("dispatch", {
            request: { type: "settings" },
          })
        ).keyboardWidth === 320,
    );
    await editor.locator("p").first().click();
    // Set an exact DOM selection independent of platform shortcut handling
    // after the test switches Windows input layouts.
    await editor
      .locator("p")
      .first()
      .evaluate((paragraph) => {
        const range = document.createRange();
        range.setStart(paragraph.firstChild, 0);
        range.setEnd(paragraph.firstChild, 6);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    assert.equal(
      (await page.evaluate(() => window.getSelection()?.toString()))?.length,
      6,
    );
    await page
      .getByRole("button", { name: "Маркер текста", exact: true })
      .click();
    await page.getByRole("button", { name: "Зелёный маркер" }).click();
    await page.locator('.tiptap mark[data-highlight="green"]').waitFor();
    await page
      .getByRole("button", { name: "Сохранено", exact: true })
      .waitFor();
    await page.screenshot({ path: "artifacts/native-keyboard-highlight.png" });
  }
  if (pasteIdleTest) {
    const fixture = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 800;
      c.height = 500;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#986ccd";
      ctx.fillRect(0, 0, 800, 500);
      ctx.fillStyle = "#20dd50";
      ctx.fillRect(0, 400, 800, 100);
      return c.toDataURL("image/png").split(",")[1];
    });
    const fixturePath = path.join(profile, "clipboard-fixture.png");
    await writeFile(fixturePath, Buffer.from(fixture, "base64"));
    clipboardHelper = spawn(
      "powershell",
      [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/test-clipboard.ps1",
      ],
      {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, NOT_TEST_CLIPBOARD_IMAGE: fixturePath },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    await waitClipboard("image-ready");
    const pasteEditor = page.getByRole("textbox", { name: "Текст записи" });
    await pasteEditor.click();
    await pasteEditor.press("Control+End");
    await pasteEditor.press("Control+v");
    await page.waitForFunction(
      () => document.querySelectorAll(".node-image img").length === 1,
    );
    await page.locator(".node-image img").evaluate(async (img) => {
      await img.decode();
      assertImage(img);
      function assertImage(i) {
        if (i.naturalWidth !== 800 || i.naturalHeight !== 500)
          throw Error("Pasted image dimensions mismatch");
      }
    });
    const ready = waitClipboard("files-ready");
    clipboardHelper.stdin.write("files\n");
    await ready;
    await pasteEditor.click();
    await pasteEditor.press("Control+End");
    await pasteEditor.press("Control+v");
    await page.waitForFunction(
      () => document.querySelectorAll(".node-image img").length === 2,
    );
    pastedImageCount = 2;
    await page
      .getByRole("button", { name: "Сохранено", exact: true })
      .waitFor();
    clipboardHelper.stdin.end("restore\n");
    await new Promise((resolve) => clipboardHelper.once("exit", resolve));
    clipboardHelper = null;
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .first()
      .click();
    const select = page.getByRole("combobox", {
      name: "Блокировка при бездействии",
    });
    assert.equal(await select.inputValue(), "30");
    await select.selectOption("0");
    await page.waitForFunction(
      async () =>
        (
          await window.__TAURI_INTERNALS__.invoke("dispatch", {
            request: { type: "settings" },
          })
        ).idleLockMinutes === 0,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть", exact: true })
      .click();
    console.log(
      "Native clipboard bitmap and Explorer file paste passed; checking disabled idle timer for 65 seconds.",
    );
    await new Promise((resolve) => setTimeout(resolve, 65000));
    assert.equal(await page.locator(".tiptap").count(), 1);
  }
  await page.screenshot({ path: "artifacts/native-journal.png" });
  await stop();
  await browser.close();
  ({ browser, page } = await launch());
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByLabel("Пароль", { exact: true }).fill("wrong password");
  await page.getByRole("button", { name: "Открыть дневник" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Неверный пароль" })
    .waitFor();
  await page.getByLabel("Использовать ключ восстановления").check();
  await page.getByLabel("Ключ восстановления", { exact: true }).fill(recovery);
  await page.getByRole("button", { name: "Открыть дневник" }).click();
  await page.getByLabel("Название записи").waitFor();
  assert.equal(
    await page.getByLabel("Название записи").inputValue(),
    expectedTitle,
  );
  assert.match(
    await page.getByRole("textbox", { name: "Текст записи" }).innerText(),
    /КонтрольныйЗакрытыйТекст/,
  );
  if (!imageFixture) {
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Пункт чек-листа: Проверить чек-лист",
          exact: true,
        })
        .isChecked(),
      true,
    );
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Пункт чек-листа: Следующий пункт",
          exact: true,
        })
        .isChecked(),
      false,
    );
  }
  if (linkTest && !imageFixture) {
    const diaryUrl = page.url();
    await page.locator(".tiptap a").first().click();
    await Promise.race([
      linkVisited,
      new Promise((_, reject) => {
        linkTimer = setTimeout(
          () => reject(Error("Default browser did not visit the test URL")),
          20000,
        );
      }),
    ]);
    clearTimeout(linkTimer);
    assert.equal(
      page.url(),
      diaryUrl,
      "External navigation must not replace the diary",
    );
    assert.equal(
      await page.locator(".tiptap a").first().getAttribute("href"),
      linkUrl,
    );
    const blocked = await page.evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("dispatch", {
          request: { type: "openLink", url: "file:///C:/Windows/notepad.exe" },
        });
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(blocked, true, "Native opener must reject file URLs");
  }
  if (keyboardTest) {
    assert.equal(
      await page
        .getByRole("separator", { name: "Высота клавиатуры" })
        .getAttribute("aria-valuenow"),
      "200",
    );
    assert.equal(await page.locator(".keyboard-guide").count(), 1);
    assert.equal(
      await page
        .getByRole("separator", { name: "Ширина клавиатуры" })
        .getAttribute("aria-valuenow"),
      "320",
    );
    assert.equal(
      await page.locator('.tiptap mark[data-highlight="green"]').count(),
      1,
    );
  }
  if (imageFixture) {
    const img = page.locator(".node-image img");
    await img.waitFor();
    await img.evaluate(async (image) => image.decode());
    assert.equal(
      await page.locator(".node-image").getAttribute("data-image-layout"),
      "right",
    );
    assert.equal(
      await page.locator(".node-image").evaluate((e) => e.style.width),
      savedImageWidth,
    );
    assert.match(
      await page.locator(".node-image + p").innerText(),
      /Текст справа/,
    );
  } else assert.equal(await page.locator(".tiptap table").count(), 1);
  if (pasteIdleTest) {
    assert.equal(
      await page.locator(".node-image img").count(),
      pastedImageCount,
    );
    for (const image of await page.locator(".node-image img").all())
      await image.evaluate(async (i) => {
        await i.decode();
        if (i.naturalHeight !== 500)
          throw Error("Pasted image lost after restart");
      });
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .first()
      .click();
    const choice = page.getByRole("combobox", {
      name: "Блокировка при бездействии",
    });
    assert.equal(await choice.inputValue(), "0");
    await choice.selectOption("1");
    await page.waitForFunction(
      async () =>
        (
          await window.__TAURI_INTERNALS__.invoke("dispatch", {
            request: { type: "settings" },
          })
        ).idleLockMinutes === 1,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть", exact: true })
      .click();
    console.log(
      "Restart preserved images and disabled setting; waiting for one-minute native idle lock.",
    );
    await page
      .getByRole("heading", { name: "С возвращением." })
      .waitFor({ timeout: 70000 });
  } else
    await page
      .getByRole("button", { name: "Заблокировать", exact: true })
      .click();
  await page.getByRole("heading", { name: "С возвращением." }).waitFor();
  assert.equal(await page.locator(".tiptap").count(), 0);
  assert.equal(await page.locator(".keyboard-guide").count(), 0);
  const bytes = await readFile(path.join(profile, "vault/journal.db"));
  assert.equal(bytes.includes(Buffer.from("КонтрольныйЗакрытыйТекст")), false);
  assert.deepEqual(errors, []);
  await writeFile(
    "artifacts/native-smoke.json",
    JSON.stringify(
      {
        passed: true,
        keyboardTimings,
        imageFixture: imageFixture ? path.basename(imageFixture) : null,
        testedAt: new Date().toISOString(),
        frontendUrl: page.url(),
        viewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          deviceScaleFactor: devicePixelRatio,
        })),
        checks: [
          ...(pasteRaceTest
            ? [
                "delayed image cancelled on lock",
                "stale lock callback does not lock reopened session",
              ]
            : []),
          ...(pasteIdleTest
            ? [
                "real Windows bitmap clipboard paste",
                "Explorer file clipboard paste",
                "pasted images survive restart",
                "idle default 30 minutes",
                "never remains unlocked for 65 seconds and survives restart",
                "one-minute native idle lock",
              ]
            : []),
          ...(linkTest && !imageFixture
            ? [
                "saved link opened through Windows default handler and reached local HTTP server",
                "file URL rejected by native opener",
              ]
            : []),
          "native create",
          "recovery confirmation",
          "block save",
          "forced termination",
          "wrong password rejection",
          "recovery unlock",
          imageFixture
            ? "image size and position persisted"
            : "document, table and checklist flags persisted",
          ...(imageFixture
            ? [
                "image SHA-256 matches original",
                "bottom pixels decoded",
                "pointer resize preserves aspect ratio",
                "image drag selects text flow side",
                "drag undo/redo",
                "text geometry beside image",
              ]
            : []),
          "lock unmounts editor",
          "encrypted database",
        ],
        profile,
      },
      null,
      2,
    ),
  );
  console.log("Native smoke checks passed.");
  await stop();
  await browser.close();
} catch (error) {
  console.error(diagnostic);
  if (activePage && !activePage.isClosed()) {
    console.error(await activePage.locator("body").innerText());
    await activePage.screenshot({ path: "artifacts/native-failure.png" });
  }
  throw error;
} finally {
  if (clipboardHelper) {
    clipboardHelper.stdin.end("restore\n");
    await new Promise((resolve) => clipboardHelper.once("exit", resolve));
  }
  clearTimeout(linkTimer);
  if (linkServer) {
    linkServer.closeAllConnections();
    linkServer.close();
  }
  await stop();
}
