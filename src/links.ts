import { api, native } from "./api";

export function externalUrl(value: string): string {
  const href = value.trim();
  if (/[\u0000-\u001f\u007f]/u.test(href) || href.length > 8192)
    throw new Error("Некорректный адрес ссылки");
  const url = new URL(href);
  if (
    !(["http:", "https:"].includes(url.protocol) && url.hostname) &&
    !(url.protocol === "mailto:" && url.pathname)
  )
    throw new Error("Используйте ссылку https://, http:// или mailto:");
  return url.href;
}

export async function openLink(href: string): Promise<void> {
  const url = externalUrl(href);
  if (native) await api("openLink", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}
