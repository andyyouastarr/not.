import { chromium } from "playwright";
import { createHash } from "node:crypto";
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
  await page
    .getByRole("button", { name: "Добавить блок", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Таблица 3 × 3" }).click();
  await page.getByRole("button", { name: "Сохранено", exact: true }).waitFor();
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
          "native create",
          "recovery confirmation",
          "block save",
          "forced termination",
          "wrong password rejection",
          "recovery unlock",
          imageFixture
            ? "image size and position persisted"
            : "document and table persisted",
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
  await stop();
}
