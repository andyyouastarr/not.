import { api } from "./api";

export async function clipboardFiles(): Promise<Blob[]> {
  const files = await api("clipboardImageFiles", {});
  return files.map(({ data, mime }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    bytes.fill(0);
    return blob;
  });
}

export async function importImage(file: Blob, isActive: () => boolean) {
  if (!file.size || file.size > 25 * 1024 * 1024)
    throw new Error("Максимальный размер изображения — 25 МБ");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Не удалось прочитать изображение из буфера");
  }
  let png: Blob;
  try {
    if (bitmap.width * bitmap.height > 16_000_000)
      throw new Error(
        "Изображение слишком большое: максимум 16 миллионов пикселей",
      );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    png = await canvas.convertToBlob({ type: "image/png" });
    canvas.width = canvas.height = 0;
  } finally {
    bitmap.close();
  }
  if (png.size > 25 * 1024 * 1024)
    throw new Error("После обработки изображение превышает 25 МБ");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () =>
      reject(new Error("Не удалось прочитать изображение"));
    reader.readAsDataURL(png);
  });
  if (!isActive()) throw new Error("Вставка отменена: запись закрыта");
  return api("addPastedImage", { data });
}
