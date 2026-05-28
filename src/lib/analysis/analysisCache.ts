/**
 * Step 1.7 — Analysis Cache Layer
 *
 * Caches analysis results by file hash to avoid redundant Gemini API calls.
 * Hash is computed from: first 1MB of file + file size + last-modified timestamp.
 *
 * Storage: /public/analysis/.cache/{hash}.json
 * Frames:  /public/analysis/.cache/{hash}/frames/
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";

const CACHE_DIR = path.join(process.cwd(), "public", "analysis", ".cache");

// ── Hash computation ──

function computeFileHash(filePath: string): string {
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash("sha256");

  // Read first 1MB for content-based hashing
  const fd = fs.openSync(filePath, "r");
  const chunkSize = Math.min(1024 * 1024, stat.size); // 1MB or file size
  const buffer = Buffer.alloc(chunkSize);
  fs.readSync(fd, buffer, 0, chunkSize, 0);
  fs.closeSync(fd);

  hash.update(buffer);
  hash.update(stat.size.toString());
  hash.update(stat.mtimeMs.toString());

  return hash.digest("hex").substring(0, 16); // Short hash is sufficient
}

// ── Cache key types ──

export type CacheCategory =
  | "frame_extraction"
  | "video_analysis"
  | "screenshot_coordinates"
  | "aroll_material"
  | "broll_material"
  | "visual_blueprint"
  | "style_fingerprint";

function getCachePath(fileHash: string, category: CacheCategory): string {
  return path.join(CACHE_DIR, `${fileHash}-${category}.json`);
}

// ── Ensure cache directory exists ──

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ── Public API ──

/**
 * Get cached analysis result for a file.
 * Returns null on cache miss.
 */
export function getCached<T>(filePath: string, category: CacheCategory): T | null {
  try {
    const fileHash = computeFileHash(filePath);
    const cachePath = getCachePath(fileHash, category);

    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const raw = fs.readFileSync(cachePath, "utf-8");
    const cached = JSON.parse(raw) as { timestamp: number; data: T };

    // Cache entries are valid indefinitely (invalidated by file content change via hash)
    return cached.data;
  } catch {
    return null;
  }
}

/**
 * Store analysis result in cache.
 */
export function setCache<T>(filePath: string, category: CacheCategory, data: T): void {
  try {
    ensureCacheDir();
    const fileHash = computeFileHash(filePath);
    const cachePath = getCachePath(fileHash, category);

    const entry = {
      timestamp: Date.now(),
      sourceFile: path.basename(filePath),
      category,
      data,
    };

    fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2));
  } catch (err) {
    console.error("[AnalysisCache] Failed to write cache:", err);
  }
}

/**
 * Check if a file has cached data for a given category.
 */
export function hasCached(filePath: string, category: CacheCategory): boolean {
  try {
    const fileHash = computeFileHash(filePath);
    const cachePath = getCachePath(fileHash, category);
    return fs.existsSync(cachePath);
  } catch {
    return false;
  }
}

/**
 * Clear all cache entries for a specific file.
 */
export function clearCacheForFile(filePath: string): void {
  try {
    const fileHash = computeFileHash(filePath);
    const entries = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(fileHash));
    for (const entry of entries) {
      fs.unlinkSync(path.join(CACHE_DIR, entry));
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Clear entire analysis cache.
 */
export function clearAllCache(): void {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const entries = fs.readdirSync(CACHE_DIR);
      for (const entry of entries) {
        const entryPath = path.join(CACHE_DIR, entry);
        if (fs.statSync(entryPath).isFile()) {
          fs.unlinkSync(entryPath);
        }
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): {
  totalEntries: number;
  totalSizeBytes: number;
  categories: Record<string, number>;
} {
  const stats = {
    totalEntries: 0,
    totalSizeBytes: 0,
    categories: {} as Record<string, number>,
  };

  try {
    if (!fs.existsSync(CACHE_DIR)) return stats;

    const entries = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
    stats.totalEntries = entries.length;

    for (const entry of entries) {
      const fileStat = fs.statSync(path.join(CACHE_DIR, entry));
      stats.totalSizeBytes += fileStat.size;

      // Extract category from filename: {hash}-{category}.json
      const categoryMatch = entry.match(/-([a-z_]+)\.json$/);
      if (categoryMatch) {
        const cat = categoryMatch[1];
        stats.categories[cat] = (stats.categories[cat] ?? 0) + 1;
      }
    }
  } catch {
    // Return partial stats
  }

  return stats;
}

/**
 * Wrap an async analysis function with caching.
 * If cached result exists, returns it immediately.
 * Otherwise runs the analysis, caches the result, and returns it.
 */
export async function withCache<T>(
  filePath: string,
  category: CacheCategory,
  analysisFn: () => Promise<T>
): Promise<T> {
  // Check cache first
  const cached = getCached<T>(filePath, category);
  if (cached !== null) {
    console.log(`[AnalysisCache] Cache hit for ${path.basename(filePath)} (${category})`);
    return cached;
  }

  // Run analysis
  console.log(`[AnalysisCache] Cache miss for ${path.basename(filePath)} (${category}), running analysis...`);
  const result = await analysisFn();

  // Cache the result
  setCache(filePath, category, result);

  return result;
}
