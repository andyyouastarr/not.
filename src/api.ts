import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Commands } from "./types";
export const demo =
  import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
export const native = isTauri();
export async function api<K extends keyof Commands>(
  type: K,
  args: Commands[K][0],
): Promise<Commands[K][1]> {
  if (demo) {
    const { mock } = await import("./demo");
    return mock(type, args);
  }
  if (!native)
    throw new Error(
      "Откройте установленное приложение not. studio. Браузер не имеет доступа к хранилищу.",
    );
  return invoke("dispatch", { request: { type, ...args } });
}
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
