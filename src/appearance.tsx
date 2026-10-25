import { useState } from "react";
import { api, demo, native, errorText } from "./api";
import type { AppearancePreferences } from "./types";
import { ru } from "./ru";

let confirmed: AppearancePreferences = { theme: "dark" };
let queue: Promise<unknown> = Promise.resolve();
function apply(value: AppearancePreferences) {
  document.documentElement.dataset.theme = value.theme;
}
export async function initializeAppearance() {
  if (native || demo) {
    try {
      confirmed = await api("appearance", {});
    } catch {
      confirmed = { theme: "dark" };
    }
  }
  apply(confirmed);
}
export function changeAppearance(value: AppearancePreferences): Promise<void> {
  const next = queue
    .catch(() => {})
    .then(async () => {
      apply(value);
      try {
        confirmed = await api("setAppearance", { value });
      } catch (error) {
        apply(confirmed);
        throw error;
      }
    });
  queue = next;
  return next;
}
export function AppearanceSettings() {
  const [theme, setTheme] = useState(confirmed.theme);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <label className="setting-row appearance-setting">
        <div>
          <strong>{ru.theme}</strong>
          <small>{ru.themeDetail}</small>
        </div>
        <select
          aria-label={ru.theme}
          value={theme}
          disabled={busy}
          onChange={(event) => {
            const theme = event.target.value as AppearancePreferences["theme"];
            setTheme(theme);
            setBusy(true);
            setError("");
            void changeAppearance({ theme })
              .catch((e) => {
                setTheme(confirmed.theme);
                setError(errorText(e));
              })
              .finally(() => setBusy(false));
          }}
        >
          <option value="dark">{ru.themeDark}</option>
          <option value="light">{ru.themeLight}</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
