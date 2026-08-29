// Collects File objects out of a native HTML5 DragEvent's DataTransfer,
// replacing the Wails-side path-based drag-drop event. Uses the
// webkitGetAsEntry entries API (supported by all evergreen browsers) to walk
// one level of folder structure so "Auto Album" mode can group files by
// their top-level folder name — full recursive folder-picker UX is out of
// scope for Phase 1 (see porting plan), this only handles what a plain
// browser drop already hands us for free.

import type { UploadItem } from "../utils/UploadManager";

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(cb: (file: File) => void): void;
  createReader?(): { readEntries(cb: (entries: FileSystemEntryLike[]) => void): void };
}

function readAllEntries(reader: { readEntries(cb: (entries: FileSystemEntryLike[]) => void): void }): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve) => {
    const all: FileSystemEntryLike[] = [];
    const readBatch = () => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(all);
          return;
        }
        all.push(...entries);
        readBatch();
      });
    };
    readBatch();
  });
}

async function walkEntry(entry: FileSystemEntryLike, albumGroup: string | undefined, out: UploadItem[]): Promise<void> {
  if (entry.isFile && entry.file) {
    await new Promise<void>((resolve) => {
      entry.file!((file) => {
        out.push({ file, albumGroup });
        resolve();
      });
    });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      await walkEntry(child, albumGroup ?? entry.name, out);
    }
  }
}

export async function collectDroppedItems(dataTransfer: DataTransfer): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  const items = dataTransfer.items;

  if (items && items.length > 0 && typeof items[0]?.webkitGetAsEntry === "function") {
    const entries: FileSystemEntryLike[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry() as FileSystemEntryLike | null;
      if (entry) entries.push(entry);
    }
    for (const entry of entries) {
      await walkEntry(entry, undefined, out);
    }
    if (out.length > 0) return out;
  }

  // Fallback: flat file list, no folder-grouping information available.
  for (let i = 0; i < dataTransfer.files.length; i++) {
    out.push({ file: dataTransfer.files[i] });
  }
  return out;
}
