import { expect, test } from "vitest";
import {
  PDF_CONTENT_HEIGHT,
  PDF_CONTENT_WIDTH,
  pdfImageWidth,
  validatePdfDocument,
} from "./pdfDocument";

test("PDF keeps A4 geometry independent of screen width and retains fractional image widths", () => {
  expect(PDF_CONTENT_WIDTH).toBeCloseTo(657.64, 1);
  expect(PDF_CONTENT_HEIGHT).toBeCloseTo(986.46, 1);
  expect(pdfImageWidth(12.345)).toBe(12.345);
  expect(pdfImageWidth(101)).toBe(100);
  expect(pdfImageWidth(NaN)).toBe(100);
});

test("PDF refuses unknown nodes and formatting instead of losing content", () => {
  expect(() =>
    validatePdfDocument({ type: "doc", content: [{ type: "futureNode" }] }),
  ).toThrow("неподдерживаемый");
  expect(() =>
    validatePdfDocument({
      type: "text",
      text: "x",
      marks: [{ type: "futureMark" }],
    }),
  ).toThrow("форматирование");
});

test("PDF validates timestamp and attachment identity", () => {
  expect(() =>
    validatePdfDocument({
      type: "timestampDivider",
      attrs: { date: "2024-02-29" },
    }),
  ).not.toThrow();
  expect(() =>
    validatePdfDocument({
      type: "timestampDivider",
      attrs: { date: "2025-02-29" },
    }),
  ).toThrow("дата");
  expect(() =>
    validatePdfDocument({
      type: "image",
      attrs: { src: "https://remote/image" },
    }),
  ).toThrow("идентификатор");
  expect(() =>
    validatePdfDocument({
      type: "text",
      text: "Связанный текст",
      marks: [{ type: "taskLink", attrs: { fragmentId: "id" } }],
    }),
  ).not.toThrow();
});
