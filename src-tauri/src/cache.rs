use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct CachePathInfo {
    pub path: String,
    pub exists: bool,
    pub file_count: usize,
    pub total_size: u64,
    pub client_name: String,
}

#[derive(Debug, Serialize)]
pub struct CacheFileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: f64,
}

pub fn get_default_cache_paths() -> Vec<String> {
    let mut paths = Vec::new();
    let discord_clients = [
        "discord",
        "discordptb",
        "discordcanary",
        "discorddevelopment",
    ];
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            for client in &discord_clients {
                let p = PathBuf::from(&appdata)
                    .join(client)
                    .join("Cache")
                    .join("Cache_Data");
                paths.push(p.to_string_lossy().to_string());
            }
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            // Browsers with User Data/profile structure
            let browsers_with_profiles: &[&str] = &[
                "Google/Chrome",
                "BraveSoftware/Brave-Browser",
                "Microsoft/Edge",
            ];
            for browser in browsers_with_profiles {
                let user_data_dir = PathBuf::from(&localappdata).join(browser).join("User Data");
                collect_chromium_profiles(&user_data_dir, &mut paths);
            }
            // Opera doesn't use User Data/profile structure
            let opera_cache = PathBuf::from(&localappdata)
                .join("Opera Software/Opera Stable")
                .join("Cache")
                .join("Cache_Data");
            paths.push(opera_cache.to_string_lossy().to_string());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let app_support = PathBuf::from(&home).join("Library/Application Support");
            let lib_caches = PathBuf::from(&home).join("Library/Caches");
            for client in &discord_clients {
                let p = app_support.join(client).join("Cache/Cache_Data");
                paths.push(p.to_string_lossy().to_string());
            }

            let browsers: &[(&str, &str)] = &[
                ("Google/Chrome", "Google/Chrome"),
                ("BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser"),
                ("Microsoft Edge", "Microsoft Edge"),
            ];
            for (app_support_name, caches_name) in browsers {
                collect_chromium_profiles(&app_support.join(app_support_name), &mut paths);
                collect_chromium_profiles(&lib_caches.join(caches_name), &mut paths);
            }

            // Opera now uses Default profile subfolder (Chromium layout)
            collect_chromium_profiles(&app_support.join("com.operasoftware.Opera"), &mut paths);
            collect_chromium_profiles(&lib_caches.join("com.operasoftware.Opera"), &mut paths);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let config_dir = PathBuf::from(&home).join(".config");
            let cache_dir = PathBuf::from(&home).join(".cache");
            for client in &discord_clients {
                let p = config_dir.join(client).join("Cache/Cache_Data");
                paths.push(p.to_string_lossy().to_string());
            }

            // Chromium browsers store profile data in ~/.config/ but cache in ~/.cache/
            let browsers_config: &[&str] = &[
                "google-chrome",
                "BraveSoftware/Brave-Browser",
                "microsoft-edge",
            ];
            let browsers_cache: &[&str] = &[
                "google-chrome",
                "BraveSoftware/Brave-Browser",
                "microsoft-edge",
            ];
            for browser in browsers_config {
                collect_chromium_profiles(&config_dir.join(browser), &mut paths);
            }
            for browser in browsers_cache {
                collect_chromium_profiles(&cache_dir.join(browser), &mut paths);
            }

            // Opera
            collect_chromium_profiles(&config_dir.join("opera"), &mut paths);
            collect_chromium_profiles(&cache_dir.join("opera"), &mut paths);
        }
    }

    paths
}

/// Resolve the cache directory for a given profile path.
/// Checks `Cache/Cache_Data` first, then falls back to `Cache/`.
/// Returns the path that exists, or `Cache/Cache_Data` as default.
fn resolve_cache_dir(profile_dir: &Path) -> PathBuf {
    let cache_data = profile_dir.join("Cache").join("Cache_Data");
    if cache_data.is_dir() {
        return cache_data;
    }
    let cache_only = profile_dir.join("Cache");
    if cache_only.is_dir() {
        return cache_only;
    }
    // Neither exists yet — return Cache_Data as the canonical default
    cache_data
}
/// Scan a Chromium browser directory for all profile cache folders.
/// Checks for "Default", "Profile 1", "Profile 2", etc.
/// Uses `resolve_cache_dir` to handle both `Cache/Cache_Data` and `Cache/` layouts.
fn collect_chromium_profiles(browser_dir: &Path, paths: &mut Vec<String>) {
    if !browser_dir.is_dir() {
        // Still add the Default path so it shows as "not found" rather than invisible
        let default_cache = browser_dir.join("Default").join("Cache").join("Cache_Data");
        paths.push(default_cache.to_string_lossy().to_string());
        return;
    }
    // Always check Default
    let default_dir = browser_dir.join("Default");
    let default_cache = resolve_cache_dir(&default_dir);
    paths.push(default_cache.to_string_lossy().to_string());
    // Scan for "Profile N" directories
    if let Ok(entries) = std::fs::read_dir(browser_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("Profile ") && entry.path().is_dir() {
                let profile_cache = resolve_cache_dir(&entry.path());
                if profile_cache.is_dir() {
                    paths.push(profile_cache.to_string_lossy().to_string());
                }
            }
        }
    }
}

pub fn validate_cache_path(path: &str) -> Result<CachePathInfo, String> {
    let dir = Path::new(path);
    let client_name = extract_client_name(path);

    if !dir.exists() {
        return Ok(CachePathInfo {
            path: path.to_string(),
            exists: false,
            file_count: 0,
            total_size: 0,
            client_name,
        });
    }

    let mut file_count = 0usize;
    let mut total_size = 0u64;

    let entries = std::fs::read_dir(dir).map_err(|e| format!("Cannot read directory: {}", e))?;
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_cache_file(&name) {
                    file_count += 1;
                    total_size += meta.len();
                }
            }
        }
    }

    Ok(CachePathInfo {
        path: path.to_string(),
        exists: true,
        file_count,
        total_size,
        client_name,
    })
}

pub fn list_cache_files(dir: &str) -> Result<Vec<CacheFileEntry>, String> {
    let path = Path::new(dir);
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", dir));
    }

    let mut files = Vec::new();
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_cache_file(&name) {
                    let modified_at = meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64())
                        .unwrap_or(0.0);
                    files.push(CacheFileEntry {
                        name: name.clone(),
                        path: entry.path().to_string_lossy().to_string(),
                        size: meta.len(),
                        modified_at,
                    });
                }
            }
        }
    }

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// Check if a filename matches a Chromium cache file pattern.
/// Supports two formats:
///  - Blockfile backend (Windows): `f_XXXXXX` (8 chars: "f_" + 6 hex digits)
///  - Simple Cache backend (macOS/Linux): `{16 hex chars}_{stream}` (e.g. "170e8695a0c85bd4_0")
fn is_cache_file(name: &str) -> bool {
    // Blockfile format: f_XXXXXX
    if name.len() == 8 && name.starts_with("f_") {
        return name[2..].chars().all(|c| c.is_ascii_hexdigit());
    }
    // Simple Cache format: {16 hex}_0 or {16 hex}_1 or {16 hex}_s
    if name.len() >= 18 {
        if let Some(underscore_pos) = name.rfind('_') {
            let hash_part = &name[..underscore_pos];
            let suffix = &name[underscore_pos + 1..];
            if hash_part.len() == 16
                && hash_part.chars().all(|c| c.is_ascii_hexdigit())
                && (suffix == "0" || suffix == "1" || suffix == "s")
            {
                return true;
            }
        }
    }
    false
}

fn extract_client_name(path: &str) -> String {
    let lower = path.to_lowercase();
    let profile = extract_profile_label(path);

    let base = if lower.contains("discorddevelopment") {
        "Discord Development"
    } else if lower.contains("discordcanary") {
        "Discord Canary"
    } else if lower.contains("discordptb") {
        "Discord PTB"
    } else if lower.contains("discord") {
        "Discord"
    } else if lower.contains("brave") {
        "Brave"
    } else if lower.contains("google") && lower.contains("chrome") || lower.contains("google-chrome") {
        "Chrome"
    } else if lower.contains("edge") || lower.contains("microsoft-edge") {
        "Edge"
    } else if lower.contains("opera") {
        "Opera"
    } else {
        "Custom"
    };

    match profile {
        Some(p) => format!("{} ({})", base, p),
        None => base.to_string(),
    }
}

/// Extract a human-readable profile label from a cache path.
/// e.g., ".../Profile 2/Cache/Cache_Data" -> Some("Profile 2")
/// e.g., ".../Default/Cache/Cache_Data" -> None (Default is implied)
fn extract_profile_label(path: &str) -> Option<String> {
    // Normalize separators
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    // Look for "Profile N" segment (typically 2 segments before "Cache/Cache_Data")
    for part in &parts {
        if part.starts_with("Profile ") {
            return Some(part.to_string());
        }
    }
    None
}
