import { useState, type ReactNode } from "react";

// WebView2 scans even selects inside closed details during text input.
// Mount the controls only while their menu is actually open.
export default function CardMenu({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="card-menu"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary aria-label={`Действия: ${title}`}>Действия</summary>
      {open && <div>{children}</div>}
    </details>
  );
}
