import { expect, test } from "vitest";
import { keyboardRows } from "./keyboardLayout";

test("Russian and US reference maps preserve geometry, home keys and punctuation", () => {
  const en = keyboardRows("en-US");
  const ru = keyboardRows("ru-RU");
  for (const rows of [en, ru]) {
    expect(
      rows.map((row) => row.reduce((sum, key) => sum + key.width, 0)),
    ).toEqual([15, 15, 15, 15, 15]);
    expect(rows.flat().every((key) => Number.isInteger(key.zone))).toBe(true);
  }
  expect(
    en
      .flat()
      .filter((key) => key.home)
      .map((key) => key.label),
  ).toEqual(["F", "J"]);
  expect(
    ru
      .flat()
      .filter((key) => key.home)
      .map((key) => key.label),
  ).toEqual(["А", "О"]);
  expect(ru[0][3]).toMatchObject({ label: "3", shifted: "№" });
  expect(en[0][3]).toMatchObject({ label: "3", shifted: "#" });
  expect(ru[3][10]).toMatchObject({ label: ".", shifted: "," });
  expect(ru[1][13]).toMatchObject({ label: "\\", shifted: "/" });
});
