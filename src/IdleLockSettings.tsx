import { useState } from "react";
import { ru } from "./ru";

const presets = [1, 5, 15, 30, 60, 0];
export default function IdleLockSettings({
  minutes,
  onSave,
}: {
  minutes: number;
  onSave: (minutes: number) => Promise<void>;
}) {
  const [custom, setCustom] = useState(!presets.includes(minutes));
  const [value, setValue] = useState(String(minutes || 30));
  const [saving, setSaving] = useState(false);
  const save = async (next: number) => {
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="idle-lock-settings">
      <label className="setting-row">
        <div>
          <strong>{ru.idleLock}</strong>
          <small>{ru.idleLockDetail}</small>
        </div>
        <select
          aria-label={ru.idleLock}
          disabled={saving}
          value={custom ? "custom" : minutes}
          onChange={(e) => {
            if (e.target.value === "custom") {
              setCustom(true);
              setValue(String(minutes || 30));
            } else {
              setCustom(false);
              void save(Number(e.target.value));
            }
          }}
        >
          {presets.map((n) => (
            <option key={n} value={n}>
              {n ? `${n} ${ru.minutes}` : ru.never}
            </option>
          ))}
          <option value="custom">{ru.customTime}</option>
        </select>
      </label>
      {custom && (
        <form
          className="idle-lock-custom"
          onSubmit={(e) => {
            e.preventDefault();
            void save(Number(value));
          }}
        >
          <label>
            {ru.idleMinutes}
            <input
              type="number"
              min="1"
              max="240"
              step="1"
              required
              value={value}
              disabled={saving}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <button type="submit" disabled={saving}>
            {ru.saveSetting}
          </button>
        </form>
      )}
      <p className="hint">{ru.idleWindowsLock}</p>
    </div>
  );
}
