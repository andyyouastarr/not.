import type { JSONContent } from "@tiptap/react";
export interface Entry {
  id: string;
  date: string;
  title: string;
  document: JSONContent;
  favorite: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface Summary {
  id: string;
  date: string;
  title: string;
  excerpt: string;
  favorite: boolean;
  deleted: boolean;
  updatedAt: string;
}
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}
export interface Preferences {
  opaque: boolean;
  lastEntry: string | null;
  recoveryConfirmed: boolean;
}
export type SaveEntry = Pick<
  Entry,
  "id" | "date" | "title" | "document" | "revision"
>;
export interface Commands {
  pendingRecovery: [{}, string | null];
  status: [{}, { exists: boolean; unlocked: boolean }];
  create: [{ password: string }, { recoveryKey: string }];
  unlock: [{ credential: string; recovery: boolean }, boolean];
  confirmRecovery: [{ key: string }, boolean];
  lock: [{}, boolean];
  touch: [{}, boolean];
  close: [{}, boolean];
  list: [
    { query: string; filter: string; date: string; offset: number },
    Summary[],
  ];
  get: [{ id: string }, Entry];
  save: [{ entry: SaveEntry }, Entry];
  toggle: [
    { id: string; field: "favorite" | "deleted"; value: boolean },
    boolean,
  ];
  settings: [{}, Preferences];
  setSettings: [{ value: Preferences }, boolean];
  changePassword: [{ password: string }, boolean];
  addAttachment: [{}, Attachment | null];
  readAttachment: [{ id: string }, { data: string; mime: string }];
  saveAttachment: [{ id: string }, boolean | null];
  backup: [{}, boolean | null];
  dailyBackup: [{}, boolean];
  restore: [{ credential: string; recovery: boolean }, boolean | null];
  export: [{ id: string }, string | null];
}
