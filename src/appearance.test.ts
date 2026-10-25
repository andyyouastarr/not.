import { beforeEach, afterEach, expect, test, vi } from "vitest";
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ api, demo: true, native: false, errorText: String }));
beforeEach(() => {
  vi.resetModules();
  api.mockReset();
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => vi.unstubAllGlobals());
test("appearance serializes rapid writes and rolls back to last committed theme", async () => {
  let finish: () => void = () => {};
  api.mockResolvedValueOnce({ theme: "dark" });
  const appearance = await import("./appearance");
  await appearance.initializeAppearance();
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ theme: "light" });
      }),
  );
  api.mockRejectedValueOnce(Error("write failed"));
  const first = appearance.changeAppearance({ theme: "light" });
  const second = appearance.changeAppearance({ theme: "dark" });
  const rejected = expect(second).rejects.toThrow("write failed");
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(document.documentElement.dataset.theme).toBe("light");
  finish();
  await first;
  await rejected;
  expect(api).toHaveBeenCalledTimes(3);
  expect(document.documentElement.dataset.theme).toBe("light");
});
test("appearance read failure applies safe dark default", async () => {
  api.mockRejectedValue(Error("read failed"));
  const appearance = await import("./appearance");
  await appearance.initializeAppearance();
  expect(document.documentElement.dataset.theme).toBe("dark");
});
