/**
 * macOS Full Disk Access permission utilities.
 *
 * On macOS 10.14+, reading file *contents* inside ~/Library/Application Support/<other-app>/
 * requires Full Disk Access (TCC). Directory listing (readdir) and stat work, but read() fails.
 *
 * IMPORTANT: macOS TCC denials produce EPERM (errno 1), NOT EACCES (errno 13).
 * EACCES means standard POSIX file permission denial (ownership/mode).
 *
 * The tauri-plugin-macos-permissions checkFullDiskAccessPermission() is a HEURISTIC
 * (checks if ~/Library/Safari or ~/Library/Containers/com.apple.stocks are listable).
 * It can give FALSE POSITIVES. We now use a real probe: File::open on TCC.db.
 */

import { invoke } from "@tauri-apps/api/core";

let _isMac: boolean | null = null;

/** Returns true on macOS only. Cached after first call. */
export function isMacOS(): boolean {
  if (_isMac !== null) return _isMac;
  // navigator.platform is deprecated but universally available; covers both Intel and ARM Macs
  _isMac = /Mac|darwin/i.test(navigator.platform);
  return _isMac;
}

export interface FdaProbeResult {
  has_access: boolean;
  error_code: number | null;
  error_msg: string | null;
  binary_path: string;
}

export interface PathAccessResult {
  path: string;
  can_list_directory: boolean;
  file_read_test: {
    tested: boolean;
    success: boolean;
    error_code: number | null;
    error_msg: string | null;
    tested_file: string | null;
  };
  binary_path: string;
}

/**
 * REAL FDA probe: attempts to open /Library/Application Support/com.apple.TCC/TCC.db
 * using open(2) which actually triggers macOS TCC checks.
 * Returns detailed diagnostic info including errno and binary path.
 *
 * Returns { has_access: true } on non-macOS platforms.
 */
export async function probeFullDiskAccess(): Promise<FdaProbeResult> {
  if (!isMacOS()) {
    return { has_access: true, error_code: null, error_msg: null, binary_path: "n/a" };
  }
  try {
    return await invoke<FdaProbeResult>("probe_full_disk_access");
  } catch (err) {
    console.warn("[permissions] FDA probe failed:", err);
    // If the command itself fails, we can't determine access — assume no access on macOS
    return {
      has_access: false,
      error_code: null,
      error_msg: String(err),
      binary_path: "unknown",
    };
  }
}

/**
 * Check whether the app has Full Disk Access on macOS.
 * Uses the REAL probe (File::open on TCC.db) instead of the plugin's heuristic.
 * Returns true on non-macOS platforms.
 */
export async function checkFullDiskAccess(): Promise<boolean> {
  const result = await probeFullDiskAccess();
  if (!result.has_access) {
    console.warn(
      `[permissions] FDA probe: no access. errno=${result.error_code}, ` +
      `error="${result.error_msg}", binary="${result.binary_path}"`
    );
  }
  return result.has_access;
}

/**
 * Test whether the app can actually read files in a given directory.
 * This goes beyond the FDA check — it tests the specific path the user wants to scan.
 * Returns detailed diagnostics (can list? can read? what errno?).
 */
export async function testPathAccess(path: string): Promise<PathAccessResult> {
  try {
    return await invoke<PathAccessResult>("test_path_access", { path });
  } catch (err) {
    console.warn("[permissions] Path access test failed:", err);
    return {
      path,
      can_list_directory: false,
      file_read_test: {
        tested: false,
        success: false,
        error_code: null,
        error_msg: String(err),
        tested_file: null,
      },
      binary_path: "unknown",
    };
  }
}

/**
 * Get the path of the currently running binary.
 * On macOS, this is what needs to be added to Full Disk Access in System Settings.
 */
export async function getAppBinaryPath(): Promise<string> {
  try {
    return await invoke<string>("get_app_binary_path");
  } catch {
    return "unknown";
  }
}

/**
 * Opens macOS System Settings → Privacy & Security → Full Disk Access.
 * No-op on non-macOS platforms.
 */
export async function requestFullDiskAccess(): Promise<void> {
  if (!isMacOS()) return;
  try {
    const { requestFullDiskAccessPermission } = await import(
      "tauri-plugin-macos-permissions-api"
    );
    await requestFullDiskAccessPermission();
  } catch (err) {
    console.warn("[permissions] Failed to open FDA settings:", err);
  }
}
