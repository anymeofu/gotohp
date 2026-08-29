// Client-driven upload loop, replacing the Wails Events.On(...) push model.
// Per file: sha1 (SubtleCrypto) -> /api/dedup -> /api/upload/init ->
// PUT /api/upload/stream (XHR, for upload progress) -> /api/upload/commit
// -> optional /api/albums. Keeps the same reactive UploadState shape as the
// Wails-era manager so Upload.vue/ThreadProgress.vue need no changes.

import { reactive } from "vue";
import { albumsApi, dedupApi, settingsApi, uploadApi, uploadStream, type Settings } from "../lib/api";
import { sha1Base64 } from "../lib/hash";
import {
  recordUploadResult,
  type UploadResultEvent,
  type UploadResults,
} from "./uploadResults";

export interface ThreadStatus {
  WorkerID: number;
  Status: string;
  FilePath: string;
  FileName: string;
  Message: string;
  BytesUploaded: number;
  BytesTotal: number;
  Attempt: number;
}

export interface FileUploadResult {
  MediaKey: string;
  IsError: boolean;
  IsLivePhoto: boolean;
  Skipped: boolean;
  ErrorMessage: string;
  SkipCode: string;
  SkipReason: string;
  Path: string;
  Paths: string[];
}

export interface PreflightWarning {
  Paths: string[];
  Code: string;
  Message: string;
}

export interface AlbumStatus {
  AlbumName: string;
  ItemsAdded: number;
  TotalItems: number;
  AlbumKeys: string[];
  IsComplete: boolean;
}

export interface AlbumError {
  AlbumName: string;
  Error: string;
}

export interface UploadState {
  isUploading: boolean;
  totalFiles: number;
  uploadedFiles: number;
  threads: Map<number, ThreadStatus>;
  results: UploadResults;
  warnings: PreflightWarning[];
  totalBytes: number;
  uploadedBytes: number;
  startTime: number;
  uploadSpeed: number;
  albumStatus: AlbumStatus | null;
  isCreatingAlbum: boolean;
}

/** One dropped item to upload. `albumGroup` is the top-level folder name for
 * auto-album mode (undefined for plain files or non-auto uploads). */
export interface UploadItem {
  file: File;
  albumGroup?: string;
}

export interface StartUploadOptions {
  albumName?: string;
  albumAutoMode?: boolean;
}

function idleThread(workerId: number): ThreadStatus {
  return {
    WorkerID: workerId,
    Status: "idle",
    FilePath: "",
    FileName: "",
    Message: "",
    BytesUploaded: 0,
    BytesTotal: 0,
    Attempt: 0,
  };
}

const DEFAULT_CONCURRENCY = 3;

class UploadManager {
  private static instance: UploadManager;

  public state = reactive<UploadState>({
    isUploading: false,
    totalFiles: 0,
    uploadedFiles: 0,
    threads: new Map<number, ThreadStatus>(),
    results: {
      success: [],
      fail: [],
      skipped: [],
      warnings: [],
    },
    warnings: [],
    totalBytes: 0,
    uploadedBytes: 0,
    startTime: 0,
    uploadSpeed: 0,
    albumStatus: null,
    isCreatingAlbum: false,
  });

  private lastSpeedUpdate = 0;
  private lastBytesUploaded = 0;
  private speedSamples: number[] = [];
  private completedBytes = 0;
  private fileBytes: Map<string, number> = new Map();

  private cancelled = false;
  private abortControllers: Set<AbortController> = new Set();

  private constructor() {
    this.resetUploadResults = this.resetUploadResults.bind(this);
    this.cancelUpload = this.cancelUpload.bind(this);
    this.copyResultsAsJson = this.copyResultsAsJson.bind(this);
    this.startUpload = this.startUpload.bind(this);
  }

  public static getInstance(): UploadManager {
    if (!UploadManager.instance) {
      UploadManager.instance = new UploadManager();
    }
    return UploadManager.instance;
  }

  public resetUploadResults() {
    this.state.results.success = [];
    this.state.results.fail = [];
    this.state.results.skipped = [];
    this.state.results.warnings = [];
  }

  public cancelUpload() {
    this.cancelled = true;
    for (const controller of this.abortControllers) {
      controller.abort();
    }
  }

  public async copyResultsAsJson() {
    const resultsJson = JSON.stringify(this.state.results, null, 2);
    try {
      await navigator.clipboard.writeText(resultsJson);
      return true;
    } catch (error) {
      console.error("Failed to copy results:", error);
      return false;
    }
  }

  public async startUpload(items: UploadItem[], opts: StartUploadOptions = {}) {
    if (this.state.isUploading || items.length === 0) return;

    this.cancelled = false;
    this.abortControllers.clear();

    let settings: Settings | null = null;
    try {
      settings = await settingsApi.get();
    } catch {
      // Fall back to defaults if settings can't be fetched — non-fatal.
    }

    this.state.totalFiles = items.length;
    this.state.totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
    this.state.uploadedFiles = 0;
    this.state.uploadedBytes = 0;
    this.state.isUploading = true;
    this.state.threads.clear();
    this.state.startTime = Date.now();
    this.state.uploadSpeed = 0;
    this.lastSpeedUpdate = Date.now();
    this.lastBytesUploaded = 0;
    this.speedSamples = [];
    this.completedBytes = 0;
    this.fileBytes.clear();
    this.state.albumStatus = null;
    this.state.isCreatingAlbum = false;
    this.resetUploadResults();
    this.state.warnings = [];

    const concurrency = Math.max(1, Math.min(settings?.uploadThreads ?? DEFAULT_CONCURRENCY, 8));
    for (let workerId = 0; workerId < concurrency; workerId++) {
      this.state.threads.set(workerId, idleThread(workerId));
    }

    const forceUpload = settings?.forceUpload ?? false;

    // Collected for the post-upload album-add step: mediaKeys grouped by
    // the album they should land in ("" = no album for this item).
    const albumGroups = new Map<string, string[]>();

    const queue = [...items];
    let nextIndex = 0;

    const worker = async (workerId: number) => {
      while (!this.cancelled) {
        const index = nextIndex++;
        if (index >= queue.length) return;
        const item = queue[index];
        await this.processFile(workerId, item, forceUpload, (albumKey, mediaKey) => {
          if (!albumKey) return;
          const existing = albumGroups.get(albumKey) ?? [];
          existing.push(mediaKey);
          albumGroups.set(albumKey, existing);
        }, opts);
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, (_, workerId) => worker(workerId)),
    );

    if (!this.cancelled && albumGroups.size > 0) {
      await this.addToAlbums(albumGroups);
    }

    this.state.isUploading = false;
  }

  private async processFile(
    workerId: number,
    item: UploadItem,
    forceUpload: boolean,
    onMediaKey: (albumKey: string, mediaKey: string) => void,
    opts: StartUploadOptions,
  ) {
    const { file, albumGroup } = item;
    const controller = new AbortController();
    this.abortControllers.add(controller);

    const setThread = (patch: Partial<ThreadStatus>) => {
      const current = this.state.threads.get(workerId) ?? idleThread(workerId);
      const next = { ...current, FilePath: file.name, FileName: file.name, ...patch };
      this.state.threads.set(workerId, next);
    };

    const albumKey = opts.albumAutoMode
      ? (albumGroup ?? "")
      : (opts.albumName ?? "");

    const finish = (event: UploadResultEvent) => {
      this.state.uploadedFiles += recordUploadResult(this.state.results, event);
      this.updateBytesAndSpeed();
    };

    try {
      if (this.cancelled) return;
      setThread({ Status: "hashing", BytesUploaded: 0, BytesTotal: file.size, Attempt: 1 });
      const sha1B64 = await sha1Base64(file);

      if (this.cancelled) return;

      let mediaKey = "";
      let wasDuplicate = false;

      if (!forceUpload) {
        setThread({ Status: "checking" });
        try {
          const dedup = await dedupApi.check(sha1B64);
          if (dedup.mediaKey) {
            mediaKey = dedup.mediaKey;
            wasDuplicate = true;
          }
        } catch (err) {
          // Dedup failures shouldn't block upload — fall through and upload.
          console.warn("dedup check failed, uploading anyway:", err);
        }
      }

      if (wasDuplicate) {
        this.completedBytes += file.size;
        setThread({ Status: "skipped", Message: "Already exists in Google Photos" });
        finish({
          MediaKey: mediaKey,
          IsError: false,
          Skipped: true,
          ErrorMessage: "",
          SkipCode: "duplicate",
          SkipReason: "Already exists in Google Photos",
          Path: file.name,
          Paths: [file.name],
        });
        onMediaKey(albumKey, mediaKey);
        return;
      }

      if (this.cancelled) return;
      setThread({ Status: "uploading", BytesUploaded: 0, BytesTotal: file.size });
      this.fileBytes.set(file.name, file.size);
      const initResult = await uploadApi.init(sha1B64, file.size);

      const { commitToken } = await uploadStream(
        initResult.uploadToken,
        file,
        (loaded, total) => {
          setThread({ Status: "uploading", BytesUploaded: loaded, BytesTotal: total });
          this.updateBytesAndSpeed();
        },
        controller.signal,
      );

      if (this.cancelled) return;
      setThread({ Status: "finalizing", BytesUploaded: file.size });
      const commitResult = await uploadApi.commit(commitToken, file.name, sha1B64);
      mediaKey = commitResult.mediaKey;

      this.completedBytes += file.size;
      this.fileBytes.delete(file.name);
      setThread({ Status: "completed", Message: "" });
      finish({
        MediaKey: mediaKey,
        IsError: false,
        Skipped: false,
        ErrorMessage: "",
        SkipCode: "",
        SkipReason: "",
        Path: file.name,
        Paths: [file.name],
      });
      onMediaKey(albumKey, mediaKey);
    } catch (err) {
      if (controller.signal.aborted || this.cancelled) {
        this.fileBytes.delete(file.name);
        setThread({ Status: "idle", Message: "" });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.fileBytes.delete(file.name);
      setThread({ Status: "error", Message: message });
      window.dispatchEvent(
        new CustomEvent("uploadError", { detail: { FileName: file.name, Message: message } }),
      );
      finish({
        MediaKey: "",
        IsError: true,
        Skipped: false,
        ErrorMessage: message,
        SkipCode: "",
        SkipReason: "",
        Path: file.name,
        Paths: [file.name],
      });
    } finally {
      this.abortControllers.delete(controller);
    }
  }

  private async addToAlbums(albumGroups: Map<string, string[]>) {
    for (const [albumName, mediaKeys] of albumGroups) {
      if (!albumName || mediaKeys.length === 0) continue;
      this.state.isCreatingAlbum = true;
      this.state.albumStatus = {
        AlbumName: albumName,
        ItemsAdded: 0,
        TotalItems: mediaKeys.length,
        AlbumKeys: [],
        IsComplete: false,
      };
      try {
        const { albumKeys } = await albumsApi.addToAlbum(mediaKeys, albumName);
        this.state.albumStatus = {
          AlbumName: albumName,
          ItemsAdded: mediaKeys.length,
          TotalItems: mediaKeys.length,
          AlbumKeys: albumKeys,
          IsComplete: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        window.dispatchEvent(
          new CustomEvent("albumError", { detail: { AlbumName: albumName, Error: message } }),
        );
      } finally {
        this.state.isCreatingAlbum = false;
      }
    }
  }

  private updateBytesAndSpeed() {
    let activeUploadedBytes = 0;
    this.state.threads.forEach((thread) => {
      if (thread.Status === "uploading" && thread.BytesTotal > 0) {
        activeUploadedBytes += thread.BytesUploaded;
      } else if (thread.Status === "finalizing" && thread.FilePath) {
        activeUploadedBytes += this.fileBytes.get(thread.FilePath) ?? 0;
      }
    });

    const totalUploaded = this.completedBytes + activeUploadedBytes;
    this.state.uploadedBytes = totalUploaded;

    const now = Date.now();
    const timeDelta = now - this.lastSpeedUpdate;

    if (timeDelta >= 500) {
      const bytesDelta = totalUploaded - this.lastBytesUploaded;
      const instantSpeed = (bytesDelta / timeDelta) * 1000;

      if (instantSpeed >= 0) {
        this.speedSamples.push(instantSpeed);
        if (this.speedSamples.length > 5) {
          this.speedSamples.shift();
        }
        this.state.uploadSpeed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
      }

      this.lastSpeedUpdate = now;
      this.lastBytesUploaded = totalUploaded;
    }
  }
}

export const uploadManager = UploadManager.getInstance();
