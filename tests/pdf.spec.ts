import { test, expect } from "@playwright/test";

test("PDF cancellation cleans the print DOM and pending images", async ({
  page,
}) => {
  await page.goto("/?demo");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite source module.
    const { preparePdfDocument } = await import("/src/pdfDocument.ts");
    const controller = new AbortController();
    let release: (value: {
      url: string;
      dispose: () => void;
    }) => void = () => {};
    let disposed = false;
    const pending = preparePdfDocument(
      {
        kind: "task",
        title: "Cancel",
        metadata: [],
        document: {
          type: "doc",
          content: [{ type: "image", attrs: { attachmentId: "pending" } }],
        },
      },
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      document.body,
      controller.signal,
    ).then(
      () => false,
      () => true,
    );
    controller.abort();
    release({
      url: "blob:cancelled",
      dispose: () => {
        disposed = true;
      },
    });
    return {
      rejected: await pending,
      disposed,
      count: document.querySelectorAll("#not-pdf-document,[data-pdf-ancestor]")
        .length,
    };
  });
  expect(result).toEqual({ rejected: true, disposed: true, count: 0 });
});

test("PDF image sizes, themes and viewport do not change the paper layout", async ({
  page,
}) => {
  await page.goto("/?demo");
  const measure = () =>
    page.evaluate(async () => {
      // @ts-expect-error Vite source module.
      const { preparePdfDocument } = await import("/src/pdfDocument.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 2000;
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!)));
      const prepared = await preparePdfDocument(
        {
          kind: "task",
          title: "Tall",
          metadata: [],
          document: {
            type: "doc",
            content: [
              {
                type: "image",
                attrs: {
                  attachmentId: "tall",
                  name: "Tall",
                  widthPercent: 80,
                  layout: "right",
                },
              },
              {
                type: "paragraph",
                content: [{ type: "text", text: "Text ".repeat(100) }],
              },
            ],
          },
        },
        async () => {
          const url = URL.createObjectURL(blob);
          return { url, dispose: () => URL.revokeObjectURL(url) };
        },
        document.body,
      );
      const image = prepared.element.querySelector("figure")!;
      const rect = image.getBoundingClientRect();
      const result = {
        width: prepared.element.getBoundingClientRect().width,
        height: prepared.element.getBoundingClientRect().height,
        imageHeight: rect.height,
        side: image.dataset.side,
      };
      prepared.cleanup();
      return result;
    });
  const dark = await measure();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  const light = await measure();
  expect(light).toEqual(dark);
  expect(light.imageHeight).toBeLessThan(986);
  expect(light.side).toBe("right");
});

for (const modal of [false, true]) {
  test(`A4 PDF static renderer ${modal ? "task dialog" : "diary"}`, async ({
    page,
  }, info) => {
    await page.goto("/?demo");
    await page.locator(".journal-prose").waitFor();
    const before = await page.locator(".journal-prose").innerHTML();
    const size = await page.evaluate(async (modal) => {
      // @ts-expect-error Vite serves the source module in the browser.
      const { preparePdfDocument } = await import("/src/pdfDocument.ts");
      const host = modal
        ? document.body.appendChild(document.createElement("dialog"))
        : document.body;
      if (host instanceof HTMLDialogElement) host.showModal();
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 400;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ab94d4";
      context.fillRect(0, 0, 600, 400);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!)));
      const p = (text: string) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      });
      const snapshot = {
        kind: "task",
        title: "PDF контрольный документ",
        metadata: ["Исполнитель: Тест", "Дедлайн: 28.11.2026"],
        document: {
          type: "doc",
          content: [
            p("Начало документа. Русский текст и emoji 🔥."),
            {
              type: "image",
              attrs: {
                attachmentId: "test",
                name: "Изображение слева",
                layout: "left",
                widthPercent: 35,
              },
            },
            ...Array.from({ length: 40 }, (_, i) =>
              p(
                `Контрольный абзац ${i}. ` +
                  "Текст рядом с изображением и на следующих страницах. ".repeat(
                    7,
                  ),
              ),
            ),
            { type: "timestampDivider", attrs: { date: "2026-11-28" } },
            {
              type: "table",
              content: Array.from({ length: 30 }, (_, i) => ({
                type: "tableRow",
                content: [
                  {
                    type: i === 0 ? "tableHeader" : "tableCell",
                    content: [p(`Строка таблицы ${i}`)],
                  },
                ],
              })),
            },
            p("Конец контрольного документа."),
          ],
        },
      };
      const prepared = await preparePdfDocument(
        snapshot,
        async () => {
          const url = URL.createObjectURL(blob);
          return { url, dispose: () => URL.revokeObjectURL(url) };
        },
        host,
      );
      (window as any).cleanPdf = () => {
        prepared.cleanup();
        if (modal) host.remove();
      };
      return prepared.element.getBoundingClientRect().width;
    }, modal);
    expect(size).toBeCloseTo(657.64, 0);
    const bytes = await page.pdf({
      path: info.outputPath("document.pdf"),
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const media = bytes
      .toString("latin1")
      .match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)/);
    expect(media).not.toBeNull();
    expect(Math.abs(Number(media![1]) - 595.276)).toBeLessThan(2);
    expect(Math.abs(Number(media![2]) - 841.89)).toBeLessThan(2);
    await page.evaluate(() => (window as any).cleanPdf());
    await expect(page.locator("#not-pdf-document")).toHaveCount(0);
    expect(await page.locator(".journal-prose").innerHTML()).toBe(before);
    await expect(
      page.getByRole("button", { name: "Скачать PDF" }),
    ).toBeVisible();
  });
}

test("PDF renderer refuses unknown content and clears failed resources", async ({
  page,
}) => {
  await page.goto("/?demo");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite source import.
    const { preparePdfDocument } = await import("/src/pdfDocument.ts");
    let message = "";
    try {
      await preparePdfDocument(
        {
          kind: "diary",
          title: "",
          metadata: [],
          document: { type: "doc", content: [{ type: "unknown" }] },
        },
        async () => {
          throw Error("unexpected");
        },
        document.body,
      );
    } catch (e) {
      message = String(e);
    }
    return {
      message,
      count: document.querySelectorAll("#not-pdf-document").length,
    };
  });
  expect(result.message).toContain("неподдерживаемый");
  expect(result.count).toBe(0);
});
