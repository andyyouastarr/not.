import { expect, it } from "vitest";
import {
  validTimestampDate,
  timestampLabel,
  localTimestampDate,
} from "./TimestampDivider";
it("validates real dates and formats a stable local calendar date", () => {
  for (const d of ["2026-02-29", "2026-13-01", "2026-11-31", "2026-1-01", ""])
    expect(validTimestampDate(d)).toBe(false);
  expect(validTimestampDate("2028-02-29")).toBe(true);
  expect(timestampLabel("2026-11-01")).toBe("01.11.2026");
  expect(localTimestampDate(new Date(2026, 10, 1, 0, 1))).toBe("2026-11-01");
});
