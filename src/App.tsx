import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  Search,
  Star,
  Trash2,
  Plus,
  Settings,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Maximize2,
  Minimize2,
  ArrowUpRight,
  Check,
  ChevronRight,
  ShieldCheck,
  CalendarDays,
  X,
  KeyRound,
  ArrowRight,
  Feather,
  Download,
  Upload,
  Ellipsis,
  CloudOff,
  Keyboard,
} from "lucide-react";
import type { Entry, Preferences, Summary } from "./types";
import { api, demo, native, errorText, localDate } from "./api";
import { ru } from "./ru";
import JournalEditor, { hasContent, wordCount } from "./Editor";
import { SaveQueue } from "./saveQueue";
import type { SaveState } from "./saveQueue";
import EntryList from "./EntryList";
import KeyboardGuide from "./KeyboardGuide";

function IconButton({
  title,
  onClick,
  children,
  active = false,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  onClose,
  children,
  dismissOutside = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  dismissOutside?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const outside = (dialog: HTMLDialogElement, x: number, y: number) => {
    const box = dialog.getBoundingClientRect();
    return x < box.left || x > box.right || y < box.top || y > box.bottom;
  };
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal glass"
      onPointerDown={(e) => {
        pressedOutside.current =
          dismissOutside &&
          e.button === 0 &&
          e.target === e.currentTarget &&
          outside(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerCancel={() => {
        pressedOutside.current = false;
      }}
      onClick={(e) => {
        if (
          pressedOutside.current &&
          e.target === e.currentTarget &&
          outside(e.currentTarget, e.clientX, e.clientY)
        )
          onClose();
        pressedOutside.current = false;
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <IconButton title={ru.close} onClick={onClose}>
          <X size={19} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}
function dateLabel(date: string, full = false) {
  return new Date(date + "T12:00:00").toLocaleDateString(
    "ru-RU",
    full
      ? { day: "numeric", month: "long", year: "numeric" }
      : { day: "numeric", month: "long" },
  );
}
const emptyDocument = { type: "doc", content: [{ type: "paragraph" }] };
function blank(): Entry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    date: localDate(),
    title: "",
    document: emptyDocument,
    favorite: false,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}

export default function App() {
  const [stage, setStage] = useState<
    "loading" | "create" | "locked" | "recovery" | "journal"
  >("loading");
  const [entry, setEntry] = useState<Entry | null>(null),
    [rows, setRows] = useState<Summary[]>([]),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [date, setDate] = useState("");
  const [prefs, setPrefs] = useState<Preferences>({
    opaque: false,
    lastEntry: null,
    recoveryConfirmed: false,
  });
  const [saveState, setSaveState] = useState<SaveState>("draft"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [sidebar, setSidebar] = useState(true),
    [focus, setFocus] = useState(false),
    [modal, setModal] = useState<"settings" | "restore" | "export" | null>(
      null,
    ),
    [more, setMore] = useState(false),
    [recoveryKey, setRecoveryKey] = useState("");
  const entryRef = useRef<Entry | null>(null),
    prefsRef = useRef(prefs),
    stageRef = useRef(stage),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    requestId = useRef(0),
    navigationId = useRef(0),
    loadingMore = useRef(false),
    epoch = useRef(0),
    listArgs = useRef({ query, filter, date });
  const queue = useRef<SaveQueue | null>(null);
  prefsRef.current = prefs;
  stageRef.current = stage;
  listArgs.current = { query, filter, date };
  const updateKeyboard = (
    patch: Pick<
      Preferences,
      "keyboardVisible" | "keyboardHeight" | "keyboardWidth"
    >,
  ) => {
    const value = { ...prefsRef.current, ...patch };
    prefsRef.current = value;
    setPrefs(value);
    const currentEpoch = epoch.current;
    void api("setSettings", { value }).catch((e) => {
      if (epoch.current === currentEpoch) setError(errorText(e));
    });
  };
  const refresh = useCallback(async () => {
    const ticket = ++requestId.current;
    const result = await api("list", { ...listArgs.current, offset: 0 });
    if (ticket === requestId.current) {
      setRows(result);
      setMore(result.length === 60);
    }
  }, []);
  if (!queue.current)
    queue.current = new SaveQueue(
      ({ id, date, title, document, revision }) =>
        api("save", { entry: { id, date, title, document, revision } }),
      setSaveState,
      (saved) => {
        if (entryRef.current?.id === saved.id) {
          entryRef.current = {
            ...entryRef.current,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          };
          setEntry(entryRef.current);
          if (prefsRef.current.lastEntry !== saved.id) {
            const value = { ...prefsRef.current, lastEntry: saved.id };
            prefsRef.current = value;
            setPrefs(value);
            void api("setSettings", { value }).catch((e) =>
              setError(errorText(e)),
            );
          }
        }
        void refresh().catch((e) => setError(errorText(e)));
      },
    );
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await queue.current!.flush();
  }, []);
  const showEntry = useCallback((e: Entry | null) => {
    entryRef.current = e;
    setEntry(e);
    queue.current!.reset(e);
  }, []);
  const clear = useCallback(() => {
    epoch.current++;
    navigationId.current++;
    requestId.current++;
    if (timer.current) clearTimeout(timer.current);
    queue.current!.clear();
    entryRef.current = null;
    setEntry(null);
    setRows([]);
    setQuery("");
    setDate("");
    setModal(null);
    setRecoveryKey("");
    setError("");
    setNotice("");
    setStage("locked");
  }, []);
  const openJournal = useCallback(async () => {
    const currentEpoch = epoch.current;
    const p = await api("settings", {});
    if (currentEpoch !== epoch.current) return;
    setPrefs(p);
    prefsRef.current = p;
    if (!p.recoveryConfirmed) {
      setRecoveryKey((await api("pendingRecovery", {})) || "");
      if (currentEpoch === epoch.current) setStage("recovery");
      return;
    }
    setStage("journal");
    const items = await api("list", {
      query: "",
      filter: "all",
      date: "",
      offset: 0,
    });
    if (currentEpoch !== epoch.current) return;
    setRows(items);
    setMore(items.length === 60);
    let initial: Entry | null = null;
    if (p.lastEntry) {
      try {
        const e = await api("get", { id: p.lastEntry });
        if (!e.deleted) initial = e;
      } catch {
        /* An absent remembered entry is harmless. */
      }
    }
    if (!initial && items[0]) initial = await api("get", { id: items[0].id });
    if (currentEpoch !== epoch.current) return;
    showEntry(initial);
    void api("dailyBackup", {}).catch(() => setError(ru.backupFail));
  }, [showEntry]);
  useEffect(() => {
    let live = true;
    api("status", {})
      .then(async (s) => {
        if (!live) return;
        if (s.unlocked) await openJournal();
        else setStage(s.exists ? "locked" : "create");
      })
      .catch((e) => {
        if (live) {
          setError(errorText(e));
          setStage("locked");
        }
      });
    return () => {
      live = false;
    };
  }, [openJournal]);
  useEffect(() => {
    if (stage !== "journal") return;
    const t = setTimeout(
      () => void refresh().catch((e) => setError(errorText(e))),
      180,
    );
    return () => clearTimeout(t);
  }, [query, filter, date, stage, refresh]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!native) return;
    const unsubs: Promise<() => void>[] = [];
    unsubs.push(listen("vault-locked", clear));
    unsubs.push(
      listen("vault-lock-request", () => {
        void flush()
          .finally(() => api("lock", {}))
          .catch(() => {});
      }),
    );
    unsubs.push(
      listen("close-request", () => {
        void flush()
          .then(() => api("close", {}))
          .catch((e) => setError(errorText(e)));
      }),
    );
    return () => {
      unsubs.forEach((p) => void p.then((f) => f()));
    };
  }, [clear, flush]);
  useEffect(() => {
    if (stage !== "journal") return;
    let touched = 0;
    const activity = () => {
      if (Date.now() - touched > 10000) {
        touched = Date.now();
        void api("touch", {}).catch(() => {});
      }
    };
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    window.addEventListener("wheel", activity, { passive: true });
    const backup = setInterval(
      () =>
        void flush()
          .then(() => api("dailyBackup", {}))
          .catch(() => setError(ru.backupFail)),
      60_000,
    );
    return () => {
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("wheel", activity);
      clearInterval(backup);
    };
  }, [stage, flush]);
  const remember = async (id: string) => {
    const p = { ...prefsRef.current, lastEntry: id };
    setPrefs(p);
    prefsRef.current = p;
    await api("setSettings", { value: p });
  };
  const navigate = async (id: string) => {
    const ticket = ++navigationId.current;
    const currentEpoch = epoch.current;
    try {
      await flush();
      if (currentEpoch !== epoch.current || ticket !== navigationId.current)
        return;
      if (entryRef.current?.id === id) return;
      const e = await api("get", { id });
      if (currentEpoch !== epoch.current || ticket !== navigationId.current)
        return;
      // Preserve edits made while the next document was loading.
      await flush();
      if (currentEpoch !== epoch.current || ticket !== navigationId.current)
        return;
      showEntry(e);
      await remember(id);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const createEntry = async () => {
    const ticket = ++navigationId.current;
    const currentEpoch = epoch.current;
    try {
      await flush();
      if (currentEpoch !== epoch.current || ticket !== navigationId.current)
        return;
      showEntry(blank());
      setFilter("all");
      setDate("");
      setQuery("");
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const update = (patch: Partial<Entry>) => {
    const current = entryRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    entryRef.current = next;
    setEntry(next);
    if (!next.revision && !next.title.trim() && !hasContent(next.document)) {
      queue.current!.reset(next);
      return;
    }
    queue.current!.update(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => void flush().catch((e) => setError(errorText(e))),
      500,
    );
  };
  const toggle = async (field: "favorite" | "deleted", value: boolean) => {
    try {
      await flush();
      const e = entryRef.current;
      if (!e?.revision) return;
      await api("toggle", { id: e.id, field, value });
      const updated = await api("get", { id: e.id });
      showEntry(updated);
      await refresh();
      if (field === "deleted") {
        showEntry(null);
      }
    } catch (e) {
      setError(errorText(e));
    }
  };
  const lock = async () => {
    try {
      await flush();
      await api("lock", {});
      clear();
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (stageRef.current !== "journal") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void createEntry();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flush().catch((e) => setError(errorText(e)));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFocus(false);
        setSidebar(true);
        setTimeout(
          () => document.querySelector<HTMLInputElement>("#search")?.focus(),
          0,
        );
      }
      if (e.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const loadMore = async () => {
    if (loadingMore.current) return;
    loadingMore.current = true;
    const ticket = requestId.current;
    const args = { ...listArgs.current };
    try {
      const result = await api("list", { ...args, offset: rows.length });
      if (
        ticket !== requestId.current ||
        JSON.stringify(args) !== JSON.stringify(listArgs.current)
      )
        return;
      setRows((old) => [
        ...old,
        ...result.filter((r) => !old.some((e) => e.id === r.id)),
      ]);
      setMore(result.length === 60);
    } finally {
      loadingMore.current = false;
    }
  };
  const groupTitle =
    filter === "favorites"
      ? ru.favorites
      : filter === "trash"
        ? ru.trash
        : ru.all;

  if (!native && !demo)
    return (
      <div className="welcome">
        <div className="welcome-art">
          <span className="wordmark">
            not<span>.</span>
          </span>
          <div className="orb" />
          <p>{ru.footer}</p>
        </div>
        <div className="welcome-form">
          <ShieldCheck size={30} />
          <h1>{ru.browserTitle}</h1>
          <p>{ru.browserBody}</p>
        </div>
      </div>
    );
  return (
    <div className={prefs.opaque ? "opaque" : ""}>
      {stage === "loading" ? (
        <div className="loading">
          <span className="wordmark">
            not<span>.</span>
          </span>
          <p>{ru.loading}</p>
        </div>
      ) : stage !== "journal" ? (
        <div className="welcome">
          <div className="welcome-art">
            <span className="wordmark">
              not<span>.</span>
            </span>
            <div className="orb">
              <Feather size={66} strokeWidth={0.8} />
            </div>
            <div>
              <p className="eyebrow">ЛИЧНЫЙ ДНЕВНИК</p>
              <h2>{ru.welcomeTitle}</h2>
              <p>{ru.welcomeBody}</p>
            </div>
            <footer>
              <ShieldCheck size={14} />
              {ru.private}
            </footer>
          </div>
          <div className="welcome-form">
            <div className="welcome-inner">
              {stage === "recovery" ? (
                <Recovery
                  recoveryKey={recoveryKey}
                  busy={busy}
                  onConfirm={(key) =>
                    void task(async () => {
                      await api("confirmRecovery", { key });
                      setRecoveryKey("");
                      await openJournal();
                    })
                  }
                />
              ) : (
                <Auth
                  create={stage === "create"}
                  busy={busy}
                  onSubmit={(credential, recovery) =>
                    void task(async () => {
                      if (stage === "create") {
                        const { recoveryKey } = await api("create", {
                          password: credential,
                        });
                        setRecoveryKey(recoveryKey);
                        setStage("recovery");
                      } else {
                        await api("unlock", { credential, recovery });
                        await openJournal();
                      }
                    })
                  }
                />
              )}
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              {stage !== "recovery" && (
                <button
                  className="text-button restore-link"
                  onClick={() => setModal("restore")}
                >
                  <Upload size={15} />
                  {ru.restoreBackup}
                </button>
              )}
            </div>
            <div className="welcome-bottom">
              <Lock size={13} />
              {ru.encrypted} · без аккаунта и облака
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`workspace ${!sidebar ? "nav-collapsed" : ""} ${focus ? "focus-mode" : ""} ${prefs.keyboardVisible ? "keyboard-docked" : ""}`}
          style={
            {
              "--keyboard-dock-width": `${Math.min(prefs.keyboardWidth ?? 360, 520)}px`,
            } as import("react").CSSProperties
          }
        >
          <aside className="sidebar glass">
            <div className="brand-row">
              <span className="wordmark">
                not<span>.</span>
              </span>
              <IconButton title={ru.collapse} onClick={() => setSidebar(false)}>
                <PanelLeftClose size={17} />
              </IconButton>
            </div>
            <p className="sidebar-caption">{ru.tagline}</p>
            <button className="new-button" onClick={() => void createEntry()}>
              <Plus size={17} />
              <span>{ru.newEntry}</span>
              <kbd>Ctrl N</kbd>
            </button>
            <div className="nav-label">МОЁ ПРОСТРАНСТВО</div>
            <nav>
              {[
                { id: "all", label: ru.all, icon: BookOpen },
                { id: "favorites", label: ru.favorites, icon: Star },
                { id: "trash", label: ru.trash, icon: Trash2 },
              ].map((n) => (
                <button
                  key={n.id}
                  className={filter === n.id ? "nav-item selected" : "nav-item"}
                  onClick={() => {
                    setFilter(n.id);
                    setDate("");
                    setQuery("");
                  }}
                >
                  <n.icon size={17} />
                  <span>{n.label}</span>
                  {filter === n.id && <span className="nav-dot" />}
                </button>
              ))}
            </nav>
            <div className="sidebar-spacer" />
            <div className="sidebar-quote">
              <span>«</span>
              <p>
                У каждого дня
                <br />
                есть своя история.
              </p>
            </div>
            <div className="sidebar-bottom">
              <button className="nav-item" onClick={() => setModal("settings")}>
                <Settings size={17} />
                {ru.settings}
              </button>
              <button className="nav-item" onClick={() => void lock()}>
                <Lock size={17} />
                {ru.lock}
              </button>
              <div className="private-label">
                <span />
                {ru.private}
              </div>
            </div>
          </aside>
          <div className="entry-column">
            <section className="entry-list">
              <header>
                <div>
                  {!sidebar && (
                    <IconButton
                      title={ru.expand}
                      onClick={() => setSidebar(true)}
                    >
                      <PanelLeftOpen size={17} />
                    </IconButton>
                  )}
                  <h1>{ru.journal}</h1>
                </div>
                <IconButton
                  title={ru.newEntry}
                  onClick={() => void createEntry()}
                >
                  <Plus size={19} />
                </IconButton>
              </header>
              <div className="compact-nav">
                <select
                  aria-label="Раздел дневника"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setQuery("");
                    setDate("");
                  }}
                >
                  <option value="all">{ru.all}</option>
                  <option value="favorites">{ru.favorites}</option>
                  <option value="trash">{ru.trash}</option>
                </select>
                <IconButton title={ru.lock} onClick={() => void lock()}>
                  <Lock size={15} />
                </IconButton>
              </div>
              <div className="search-box">
                <Search size={16} />
                <input
                  id="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={ru.search}
                  aria-label={ru.search}
                />
                <kbd>Ctrl K</kbd>
              </div>
              <div className="list-filter">
                <span>{date ? dateLabel(date) : groupTitle}</span>
                <label className="calendar-button" title={ru.calendar}>
                  <CalendarDays size={16} />
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    aria-label={ru.calendar}
                  />
                </label>
                {date && (
                  <IconButton title={ru.clearDate} onClick={() => setDate("")}>
                    <X size={13} />
                  </IconButton>
                )}
              </div>
              <EntryList
                rows={rows}
                currentId={entry?.id}
                onSelect={(id) => void navigate(id)}
                more={more}
                onMore={() => void task(loadMore)}
                scope={`${filter}/${query}/${date}`}
                empty={
                  query
                    ? ru.emptySearch
                    : filter === "trash"
                      ? ru.emptyTrash
                      : filter === "favorites"
                        ? ru.emptyFavorites
                        : "Пока нет записей"
                }
              />
              <footer className="list-footer">
                <ShieldCheck size={13} />
                {ru.encrypted}
                <span>
                  {rows.length}
                  {more ? "+" : ""}
                </span>
              </footer>
            </section>
            {prefs.keyboardVisible && (
              <KeyboardGuide
                height={prefs.keyboardHeight ?? 190}
                width={Math.min(prefs.keyboardWidth ?? 360, 520)}
                onWidth={(keyboardWidth) => updateKeyboard({ keyboardWidth })}
                onHeight={(keyboardHeight) =>
                  updateKeyboard({ keyboardHeight })
                }
                onClose={() => updateKeyboard({ keyboardVisible: false })}
              />
            )}
          </div>
          <main className="journal-main">
            <header className="journal-top">
              <div className="breadcrumb">
                {focus && (
                  <IconButton
                    title={ru.exitFocus}
                    onClick={() => setFocus(false)}
                  >
                    <Minimize2 size={16} />
                  </IconButton>
                )}
                <BookOpen size={14} />
                <span>{ru.journal}</span>
                <ChevronRight size={12} />
                <span>{entry ? dateLabel(entry.date) : ru.tagline}</span>
              </div>
              <div className="journal-actions">
                {entry && (
                  <>
                    <button
                      className={`save-indicator ${saveState}`}
                      onClick={() =>
                        void flush().catch((e) => setError(errorText(e)))
                      }
                      title={saveState === "error" ? ru.retry : ru.autosaveNote}
                    >
                      {saveState === "saved" ? (
                        <Check size={12} />
                      ) : saveState === "error" ? (
                        <CloudOff size={13} />
                      ) : (
                        <span className="status-dot" />
                      )}
                      {saveState === "saved"
                        ? ru.saved
                        : saveState === "saving"
                          ? ru.saving
                          : saveState === "error"
                            ? ru.saveError
                            : saveState === "dirty"
                              ? ru.unsaved
                              : ru.draft}
                    </button>
                    <span className="action-divider" />
                    <IconButton
                      title={
                        entry.favorite ? "Убрать из избранного" : ru.favorites
                      }
                      active={entry.favorite}
                      onClick={() => void toggle("favorite", !entry.favorite)}
                    >
                      <Star
                        size={17}
                        fill={entry.favorite ? "currentColor" : "none"}
                      />
                    </IconButton>
                  </>
                )}
                <button
                  className={`icon-button ${prefs.keyboardVisible ? "active" : ""}`}
                  title={ru.keyboardGuide}
                  aria-label={ru.keyboardGuide}
                  aria-expanded={!!prefs.keyboardVisible}
                  aria-controls="keyboard-guide"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    updateKeyboard({ keyboardVisible: !prefs.keyboardVisible })
                  }
                >
                  <Keyboard size={18} />
                </button>
                <IconButton
                  title={focus ? ru.exitFocus : ru.focus}
                  onClick={() => setFocus(!focus)}
                >
                  {focus ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </IconButton>
              </div>
            </header>
            {demo && <div className="demo-badge">{ru.demo}</div>}
            {entry ? (
              <div className="document-scroll">
                <article className="document">
                  <div className="document-date">
                    <span className="date-dot" />
                    <input
                      type="date"
                      aria-label="Дата записи"
                      value={entry.date}
                      disabled={entry.deleted}
                      onChange={(e) => {
                        if (e.target.value) update({ date: e.target.value });
                      }}
                    />
                    <span>
                      {new Date(entry.date + "T12:00:00").toLocaleDateString(
                        "ru-RU",
                        { weekday: "long" },
                      )}
                    </span>
                  </div>
                  <input
                    className="title-input"
                    spellCheck={false}
                    aria-label="Название записи"
                    placeholder={ru.titlePlaceholder}
                    value={entry.title}
                    maxLength={300}
                    disabled={entry.deleted}
                    onChange={(e) => update({ title: e.target.value })}
                  />
                  {entry.deleted && (
                    <div className="trash-banner">
                      {ru.trashBanner}
                      <button onClick={() => void toggle("deleted", false)}>
                        {ru.restoreEntry}
                      </button>
                    </div>
                  )}
                  <JournalEditor
                    key={entry.id}
                    document={entry.document}
                    editable={!entry.deleted}
                    onChange={(document) => update({ document })}
                    onError={setError}
                  />
                  <div className="document-end">
                    <span /> <Feather size={14} /> <span />
                  </div>
                </article>
              </div>
            ) : (
              <div className="empty-canvas">
                <div className="empty-mark">
                  <Feather size={36} strokeWidth={1} />
                </div>
                <p className="eyebrow">ВАШЕ ЛИЧНОЕ ПРОСТРАНСТВО</p>
                <h2>
                  {query || date
                    ? ru.emptySearch
                    : filter === "trash"
                      ? ru.emptyTrash
                      : filter === "favorites"
                        ? ru.emptyFavorites
                        : ru.emptyTitle}
                </h2>
                <p>
                  {query || date
                    ? ru.emptySearchBody
                    : filter === "trash"
                      ? ru.emptyTrashBody
                      : filter === "favorites"
                        ? ru.emptyFavoritesBody
                        : ru.emptyBody}
                </p>
                {filter === "all" && !query && !date && (
                  <button
                    className="primary"
                    onClick={() => void createEntry()}
                  >
                    {ru.newEntry}
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>
            )}
            <footer className="journal-footer">
              <span>
                <Lock size={12} />
                {ru.private}
              </span>
              <div>
                {entry && (
                  <>
                    <span>
                      {wordCount(entry.document)} {ru.words}
                    </span>
                    {entry.revision > 0 && (
                      <>
                        <IconButton
                          title={ru.export}
                          onClick={() => setModal("export")}
                        >
                          <ArrowUpRight size={15} />
                        </IconButton>
                        {!entry.deleted && (
                          <IconButton
                            title={ru.delete}
                            onClick={() => void toggle("deleted", true)}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        )}
                      </>
                    )}
                  </>
                )}
                <IconButton
                  title={ru.settings}
                  onClick={() => setModal("settings")}
                >
                  <Ellipsis size={17} />
                </IconButton>
              </div>
            </footer>
          </main>
        </div>
      )}
      {stage === "journal" && error && (
        <div className="toast error" role="alert">
          <span>{error}</span>
          <button aria-label={ru.close} onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button aria-label={ru.close} onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "settings" && (
        <Modal
          title={ru.settings}
          onClose={() => setModal(null)}
          dismissOutside
        >
          <div className="settings-section">
            <h3>{ru.appearance}</h3>
            <label className="setting-row">
              <div>
                <strong>{ru.opaque}</strong>
                <small>{ru.opaqueDetail}</small>
              </div>
              <input
                type="checkbox"
                role="switch"
                checked={prefs.opaque}
                onChange={(e) => {
                  const value = { ...prefs, opaque: e.target.checked };
                  setPrefs(value);
                  void api("setSettings", { value }).catch((e) =>
                    setError(errorText(e)),
                  );
                }}
              />
            </label>
          </div>
          <div className="settings-section">
            <h3>{ru.security}</h3>
            <PasswordChange
              busy={busy}
              onSubmit={(password) =>
                void task(async () => {
                  await flush();
                  await api("changePassword", { password });
                  setNotice(ru.passwordChanged);
                })
              }
            />
            <p className="hint">{ru.autosaveNote}</p>
          </div>
          <div className="settings-section">
            <h3>Резервные копии</h3>
            <p className="hint">
              Автоматически каждый день · последние 7 копий
            </p>
            <button
              className="setting-action"
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  await flush();
                  if (await api("backup", {})) setNotice(ru.backupDone);
                })
              }
            >
              <Download size={18} />
              <div>
                <strong>{ru.backup}</strong>
                <small>{ru.backupDetail}</small>
              </div>
              <ChevronRight size={16} />
            </button>
            <button
              className="setting-action"
              onClick={() => setModal("restore")}
            >
              <Upload size={18} />
              <strong>{ru.restoreBackup}</strong>
              <ChevronRight size={16} />
            </button>
          </div>
          <p className="version">not. studio · 0.1.6</p>
        </Modal>
      )}
      {modal === "restore" && (
        <Modal title={ru.restoreBackup} onClose={() => setModal(null)}>
          <p className="modal-description">{ru.restoreDetail}</p>
          <CredentialForm
            busy={busy}
            label={ru.confirmRestore}
            onSubmit={(credential, recovery) =>
              void task(async () => {
                await flush();
                if (await api("restore", { credential, recovery })) {
                  clear();
                  setNotice(ru.restoreDone);
                }
              })
            }
          />
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </Modal>
      )}
      {modal === "export" && (
        <Modal title={ru.export} onClose={() => setModal(null)}>
          <p className="modal-description">{ru.exportExplain}</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              {ru.cancel}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  await flush();
                  if (
                    entryRef.current &&
                    (await api("export", { id: entryRef.current.id }))
                  ) {
                    setNotice(ru.exportDone);
                    setModal(null);
                  }
                })
              }
            >
              {ru.exportConfirm}
              <ArrowUpRight size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function CredentialForm({
  busy,
  label,
  onSubmit,
}: {
  busy: boolean;
  label: string;
  onSubmit: (credential: string, recovery: boolean) => void;
}) {
  const [credential, setCredential] = useState(""),
    [recovery, setRecovery] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (credential) {
          onSubmit(credential, recovery);
          setCredential("");
        }
      }}
    >
      <label className="field-label">
        {recovery ? ru.recoveryKey : ru.password}
        <input
          autoFocus
          type="password"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={recovery}
          onChange={(e) => {
            setRecovery(e.target.checked);
            setCredential("");
          }}
        />
        {ru.recoveryLabel}
      </label>
      <button className="primary full" disabled={busy || !credential}>
        {label}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
function Auth({
  create,
  busy,
  onSubmit,
}: {
  create: boolean;
  busy: boolean;
  onSubmit: (credential: string, recovery: boolean) => void;
}) {
  const [password, setPassword] = useState(""),
    [again, setAgain] = useState(""),
    [error, setError] = useState("");
  if (!create)
    return (
      <>
        <div className="form-emblem">
          <KeyRound size={22} />
        </div>
        <h1>{ru.unlockTitle}</h1>
        <p className="form-intro">{ru.unlockBody}</p>
        <CredentialForm busy={busy} label={ru.unlock} onSubmit={onSubmit} />
      </>
    );
  return (
    <>
      <div className="form-emblem">
        <Feather size={23} />
      </div>
      <h1>{ru.create}</h1>
      <p className="form-intro">
        Начните с пароля. Всё остальное — ваши мысли.
      </p>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (password !== again) {
            setError(ru.mismatch);
            return;
          }
          onSubmit(password, false);
          setPassword("");
          setAgain("");
        }}
      >
        <label className="field-label">
          {ru.password}
          <input
            type="password"
            autoFocus
            required
            minLength={10}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field-label">
          {ru.passwordAgain}
          <input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </label>
        <p className="hint">{ru.passwordHint}</p>
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary full"
          disabled={busy || password.length < 10 || !again}
        >
          {ru.create}
          <ArrowRight size={16} />
        </button>
      </form>
    </>
  );
}
function Recovery({
  recoveryKey,
  busy,
  onConfirm,
}: {
  recoveryKey: string;
  busy: boolean;
  onConfirm: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  return (
    <>
      <div className="form-emblem">
        <KeyRound size={22} />
      </div>
      <h1>{ru.recoveryTitle}</h1>
      <p className="form-intro">
        {recoveryKey ? ru.recoveryBody : ru.keyMissing}
      </p>
      {recoveryKey && <code className="recovery-code">{recoveryKey}</code>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(key);
          setKey("");
        }}
      >
        <label className="field-label">
          {ru.confirmKey}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
          />
        </label>
        <button className="primary full" disabled={busy || !key}>
          {ru.confirmRecovery}
          <Check size={16} />
        </button>
      </form>
    </>
  );
}
function PasswordChange({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (s: string) => void;
}) {
  const [p, setP] = useState(""),
    [again, setAgain] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (p === again) {
          onSubmit(p);
          setP("");
          setAgain("");
        }
      }}
    >
      <label className="field-label">
        {ru.newPassword}
        <input
          type="password"
          autoComplete="new-password"
          minLength={10}
          value={p}
          onChange={(e) => setP(e.target.value)}
        />
      </label>
      <label className="field-label">
        {ru.passwordAgain}
        <input
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      <button
        className="secondary"
        disabled={busy || p.length < 10 || p !== again}
      >
        {ru.changePassword}
      </button>
    </form>
  );
}
