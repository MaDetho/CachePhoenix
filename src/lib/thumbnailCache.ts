import { openDB, type IDBPDatabase, type DBSchema } from "idb";

interface ThumbnailCacheSchema extends DBSchema {
  thumbnails: {
    key: string;
    value: {
      filePath: string;
      dataUrl: string;
      mtime: number;
      size: number;
      cachedAt: number;
    };
    indexes: { "by-cachedAt": number };
  };
}

const DB_NAME = "dccr-thumbnail-cache";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ThumbnailCacheSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<ThumbnailCacheSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ThumbnailCacheSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore("thumbnails", { keyPath: "filePath" });
        store.createIndex("by-cachedAt", "cachedAt");
      },
    });
  }
  return dbPromise;
}

export async function getCachedThumbnail(
  filePath: string,
  mtime: number,
  size: number,
): Promise<string | undefined> {
  try {
    const db = await getDB();
    const entry = await db.get("thumbnails", filePath);
    if (entry && entry.mtime === mtime && entry.size === size) {
      return entry.dataUrl;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function setCachedThumbnail(
  filePath: string,
  dataUrl: string,
  mtime: number,
  size: number,
): Promise<void> {
  try {
    const db = await getDB();
    await db.put("thumbnails", {
      filePath,
      dataUrl,
      mtime,
      size,
      cachedAt: Date.now(),
    });
  } catch {
    // Best-effort caching
  }
}

export async function clearThumbnailCache(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear("thumbnails");
  } catch {
    // Best-effort
  }
}