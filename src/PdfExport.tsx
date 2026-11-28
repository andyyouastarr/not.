import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { api, errorText, native } from "./api";
import { ru } from "./ru";
import { preparePdfDocument, type PdfExportSnapshot } from "./pdfDocument";

export interface PdfSource {
  name: () => string;
  capture: () => Promise<PdfExportSnapshot>;
}

let occupied = false;
const listeners = new Set<() => void>();
function setOccupied(value: boolean) {
  occupied = value;
  listeners.forEach((notify) => notify());
}
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};

export function pdfDate(value: string): string {
  return value.split("-").reverse().join(".");
}

export default function PdfExport({
  source,
  disabled = false,
}: {
  source: PdfSource;
  disabled?: boolean;
}) {
  const busy = useSyncExternalStore(subscribe, () => occupied);
  const button = useRef<HTMLButtonElement>(null);
  const run = useRef<AbortController | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => () => run.current?.abort(), []);
  useEffect(() => {
    if (!message || failed) return;
    const timer = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timer);
  }, [message, failed]);

  const start = async () => {
    if (occupied || disabled) return;
    if (!native) {
      setFailed(true);
      setMessage(ru.pdfNativeOnly);
      return;
    }
    setOccupied(true);
    setMessage("");
    setFailed(false);
    const controller = new AbortController();
    run.current = controller;
    let operation: string | null = null;
    let cleanup: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const check = () => controller.signal.throwIfAborted();
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          cleanup?.();
          if (operation)
            void api("cancelPdfExport", { operation }).catch(() => {});
          reject(new Error(ru.pdfCancelled));
        },
        { once: true },
      );
    });
    // Attach immediately: a close while the native Save As dialog is pending
    // must not leave an unhandled rejection.
    void cancelled.catch(() => {});
    try {
      operation = await api("beginPdfExport", { name: source.name() });
      if (!operation) return;
      check();
      timeout = setTimeout(() => controller.abort(), 60_000);
      const work = async () => {
        const snapshot = await source.capture();
        check();
        const host =
          button.current?.closest<HTMLDialogElement>("dialog[open]") ??
          document.body;
        const prepared = await preparePdfDocument(
          snapshot,
          async (id) => {
            check();
            const attachment = await api("readAttachment", { id });
            check();
            const bytes = Uint8Array.from(atob(attachment.data), (c) =>
              c.charCodeAt(0),
            );
            const url = URL.createObjectURL(
              new Blob([bytes], { type: attachment.mime }),
            );
            bytes.fill(0);
            return { url, dispose: () => URL.revokeObjectURL(url) };
          },
          host,
          controller.signal,
        );
        cleanup = prepared.cleanup;
        if (controller.signal.aborted) {
          cleanup();
          check();
        }
        const activeDialog = [...document.querySelectorAll("dialog[open]")].at(
          -1,
        );
        if (!host.isConnected || (activeDialog ?? document.body) !== host)
          throw Error(
            "Открыто другое окно. Повторите экспорт из исходного документа.",
          );
        await api("printPdfExport", { operation: operation! });
        check();
      };
      await Promise.race([work(), cancelled]);
      setMessage(ru.pdfSaved);
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailed(true);
        setMessage(errorText(error));
      } else if (button.current?.isConnected) {
        setFailed(true);
        setMessage(ru.pdfCancelled);
      }
    } finally {
      clearTimeout(timeout);
      cleanup?.();
      if (operation)
        await api("cancelPdfExport", { operation }).catch(() => {});
      if (run.current === controller) run.current = null;
      setOccupied(false);
    }
  };
  return (
    <div className="pdf-export-control">
      <button
        ref={button}
        type="button"
        title={ru.pdfDownload}
        aria-label={ru.pdfDownload}
        disabled={disabled || busy}
        aria-busy={!!run.current}
        onClick={() => void start()}
      >
        {run.current ? (
          <LoaderCircle size={16} className="pdf-export-spinner" />
        ) : (
          <Download size={16} />
        )}
      </button>
      {message && (
        <span className="pdf-export-status" role={failed ? "alert" : "status"}>
          {message}
        </span>
      )}
    </div>
  );
}
