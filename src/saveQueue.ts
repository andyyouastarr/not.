import type { Entry, SaveEntry } from "./types";
export type SaveState = "draft" | "dirty" | "saving" | "saved" | "error";
export class SaveQueue {
  private value: SaveEntry | null = null;
  private generation = 0;
  private savedGeneration = 0;
  private flight: Promise<void> | null = null;
  constructor(
    private persist: (entry: SaveEntry) => Promise<Entry>,
    private status: (s: SaveState) => void,
    private onSaved: (e: Entry) => void,
  ) {}
  reset(e: SaveEntry | null) {
    this.value = e;
    this.generation = 0;
    this.savedGeneration = 0;
    this.status(e?.revision ? "saved" : "draft");
  }
  update(e: SaveEntry) {
    this.value = {
      ...e,
      revision: this.value?.id === e.id ? this.value.revision : e.revision,
    };
    this.generation++;
    this.status("dirty");
  }
  get current() {
    return this.value;
  }
  get dirty() {
    return this.generation !== this.savedGeneration;
  }
  clear() {
    this.value = null;
    this.generation++;
    this.savedGeneration = this.generation;
  }
  async flush(): Promise<void> {
    if (this.flight) {
      await this.flight;
      if (this.dirty) return this.flush();
      return;
    }
    this.flight = this.drain();
    try {
      await this.flight;
    } finally {
      this.flight = null;
    }
  }
  private async drain() {
    while (this.value && this.dirty) {
      const generation = this.generation;
      const value = this.value;
      this.status("saving");
      try {
        const saved = await this.persist(value);
        if (this.value?.id !== value.id) return;
        this.value = { ...this.value, revision: saved.revision };
        this.savedGeneration = generation;
        this.onSaved(saved);
        this.status(this.dirty ? "dirty" : "saved");
      } catch (e) {
        this.status("error");
        throw e;
      }
    }
  }
}
