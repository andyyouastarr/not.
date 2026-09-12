export type KeyboardLayout = "en-US" | "ru-RU";
export interface GuideKey {
  label: string;
  shifted?: string;
  width: number;
  zone: number;
  home?: boolean;
}
const key = (label: string, width = 1): GuideKey => ({ label, width, zone: 0 });
const zones = [
  [1, 1, 2, 3, 4, 4, 5, 5, 6, 7, 8, 8, 8],
  [1, 2, 3, 4, 4, 5, 5, 6, 7, 8, 8, 8],
  [1, 2, 3, 4, 4, 5, 5, 6, 7, 8, 8],
  [1, 2, 3, 4, 4, 5, 5, 6, 7, 8],
];
export function keyboardRows(layout: KeyboardLayout): GuideKey[][] {
  const russian = layout === "ru-RU";
  const letters = russian
    ? ["Ё1234567890-=", "ЙЦУКЕНГШЩЗХЪ", "ФЫВАПРОЛДЖЭ", "ЯЧСМИТЬБЮ."]
    : ["`1234567890-=", "QWERTYUIOP[]", "ASDFGHJKL;'", "ZXCVBNM,./"];
  const shifts = russian
    ? [' !"№;%:?*()_+', "            ", "           ", "         ,"]
    : ["~!@#$%^&*()_+", "          {}", '         :"', "       <>?"];
  const rows = letters.map((row, r) =>
    Array.from(row, (label, i): GuideKey => ({
      label,
      shifted: shifts[r][i]?.trim() || undefined,
      width: 1,
      zone: zones[r][i],
      home: r === 2 && (i === 3 || i === 6),
    })),
  );
  rows[0].push(key("⌫", 2));
  rows[1].unshift(key("Tab", 1.5));
  rows[1].push({
    label: "\\",
    shifted: russian ? "/" : "|",
    width: 1.5,
    zone: 8,
  });
  rows[2].unshift(key("Caps", 1.75));
  rows[2].push(key("Enter", 2.25));
  rows[3].unshift(key("Shift", 2.25));
  rows[3].push(key("Shift", 2.75));
  rows.push([
    key("Ctrl", 1.25),
    key("Win", 1.25),
    key("Alt", 1.25),
    key(russian ? "Пробел" : "Space", 6.25),
    key("Alt", 1.25),
    key("Win", 1.25),
    key("☰", 1.25),
    key("Ctrl", 1.25),
  ]);
  return rows;
}
