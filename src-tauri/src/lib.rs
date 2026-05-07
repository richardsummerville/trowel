// lib.rs — Trowel Tauri commands.
//
// Four commands invoked by the frontend:
//   list_entries(collection)              → [EntrySummary]
//   read_entry(collection, slug)          → Entry
//   write_entry(collection, slug, fm, body) → ()
//   run_sync(script)                      → stdout (string)
//
// Notes are read-only; only projects/experiments/gallery are writable.
// Project root is found by walking up from CWD until we hit a package.json
// whose "name" is "pixelbrix-site". This lets the binary work whether launched
// from `cargo tauri dev` or a bundled .app.

use std::{collections::BTreeMap, env, fs, path::{Path, PathBuf}, process::Stdio};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

// ── types ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct EntrySummary {
    slug: String,
    title: String,
    date: Option<String>,
    status: Option<String>,
    group: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    slug: String,
    fm: serde_json::Value,
    body: String,
    writable: bool,
}

// ── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
fn list_entries(collection: String) -> Result<Vec<EntrySummary>, String> {
    let dir = collection_dir(&collection).map_err(stringify)?;
    let mut out = Vec::new();
    if !dir.exists() { return Ok(out); }
    for entry in fs::read_dir(&dir).map_err(stringify)? {
        let path = entry.map_err(stringify)?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
        let raw = fs::read_to_string(&path).map_err(stringify)?;
        let (fm, _) = split_frontmatter(&raw);
        out.push(EntrySummary {
            slug: path.file_stem().unwrap().to_string_lossy().into(),
            title: fm.get("title").cloned().unwrap_or_default(),
            date: fm.get("date").cloned(),
            status: fm.get("status").cloned(),
            group: fm.get("group").cloned(),
            kind: fm.get("type").cloned(),
        });
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

#[tauri::command]
fn read_entry(collection: String, slug: String) -> Result<Entry, String> {
    let path = entry_path(&collection, &slug).map_err(stringify)?;
    let raw = fs::read_to_string(&path).map_err(stringify)?;
    let (fm, body) = split_frontmatter(&raw);
    let fm_value = serde_json::to_value(parse_frontmatter_typed(&fm))
        .map_err(stringify)?;
    Ok(Entry {
        slug,
        fm: fm_value,
        body,
        writable: writable(&collection),
    })
}

#[tauri::command]
fn write_entry(
    collection: String,
    slug: String,
    fm: serde_json::Value,
    body: String,
) -> Result<(), String> {
    if !writable(&collection) {
        return Err(format!("not writable: {}", collection));
    }
    let path = entry_path(&collection, &slug).map_err(stringify)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
    }
    fs::write(&path, serialize_frontmatter(&fm, &body)).map_err(stringify)?;
    Ok(())
}

#[tauri::command]
async fn run_sync(script: String) -> Result<String, String> {
    let allowed = ["sync:notes", "sync:sources", "prefetch:books"];
    if !allowed.contains(&script.as_str()) {
        return Err(format!("script not allowed: {}", script));
    }
    let root = project_root().map_err(stringify)?;
    let out = Command::new("npm")
        .args(["run", &script])
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(stringify)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("script failed: {}", err));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ── path resolution ─────────────────────────────────────────────────────────

fn project_root() -> anyhow::Result<PathBuf> {
    // 1. Explicit override via env var.
    if let Ok(env_root) = env::var("PIXELBRIX_ROOT") {
        let p = PathBuf::from(env_root);
        if is_pixelbrix_site(&p).unwrap_or(false) { return Ok(p); }
        anyhow::bail!("PIXELBRIX_ROOT does not point to a pixelbrix-site project: {:?}", p);
    }

    // 2. Walk up from CWD. At each level, check the directory itself and
    //    its `pixelbrix-site` child — Trowel is a sibling of pixelbrix-site
    //    in the canonical layout (pixelbrix/{trowel,pixelbrix-site}), so the
    //    sibling check is what discovers it.
    let mut dir = env::current_dir()?;
    loop {
        if is_pixelbrix_site(&dir).unwrap_or(false) { return Ok(dir); }
        let sibling = dir.join("pixelbrix-site");
        if is_pixelbrix_site(&sibling).unwrap_or(false) { return Ok(sibling); }
        if !dir.pop() { break; }
    }

    Err(anyhow::anyhow!(
        "could not find pixelbrix-site project (set PIXELBRIX_ROOT env var)"
    ))
}

fn is_pixelbrix_site(p: &Path) -> anyhow::Result<bool> {
    let pkg = p.join("package.json");
    if !pkg.exists() { return Ok(false); }
    let raw = fs::read_to_string(&pkg)?;
    Ok(raw.contains("\"name\": \"pixelbrix-site\""))
}

fn writable(collection: &str) -> bool {
    matches!(collection, "projects" | "experiments" | "gallery")
}

fn collection_dir(collection: &str) -> anyhow::Result<PathBuf> {
    if !["notes", "projects", "experiments", "gallery"].contains(&collection) {
        anyhow::bail!("unknown collection: {}", collection);
    }
    Ok(project_root()?.join("src/content").join(collection))
}

fn entry_path(collection: &str, slug: &str) -> anyhow::Result<PathBuf> {
    if slug.is_empty() || slug.contains('/') || slug.contains("..") {
        anyhow::bail!("invalid slug: {:?}", slug);
    }
    let dir = collection_dir(collection)?;
    let path = dir.join(format!("{}.md", slug));
    // Defence in depth: confirm canonical path stays within the dir.
    let canon_dir = dir.canonicalize().unwrap_or(dir.clone());
    let canon_parent = path.parent().and_then(|p| p.canonicalize().ok()).unwrap_or_default();
    if !canon_parent.starts_with(&canon_dir) {
        anyhow::bail!("path escape: {:?}", path);
    }
    Ok(path)
}

// ── frontmatter (mirrors the JS server's behaviour for flat schemas) ────────

fn split_frontmatter(raw: &str) -> (BTreeMap<String, String>, String) {
    let mut map = BTreeMap::new();
    if !raw.starts_with("---\n") { return (map, raw.to_string()); }
    let rest = &raw[4..];
    if let Some(idx) = rest.find("\n---") {
        let yaml = &rest[..idx];
        let body_start = idx + 4;
        let body = rest.get(body_start..).unwrap_or("").trim_start_matches('\n').to_string();
        for line in yaml.lines() {
            if let Some((k, v)) = line.split_once(':') {
                map.insert(k.trim().into(), v.trim().trim_matches('"').into());
            }
        }
        return (map, body);
    }
    (map, raw.to_string())
}

/// Map a flat YAML frontmatter into a typed JSON object. Arrays still arrive
/// as comma-separated or newline-separated strings; we normalise to JSON arrays
/// when the value spans multiple `-` lines. For nested objects (project links,
/// gallery media) we leave the raw string and the writer handles them later.
fn parse_frontmatter_typed(fm: &BTreeMap<String, String>) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    for (k, v) in fm {
        out.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    out
}

fn serialize_frontmatter(fm: &serde_json::Value, body: &str) -> String {
    let mut out = String::from("---\n");
    if let Some(obj) = fm.as_object() {
        // Stable field order matters for readable diffs.
        let preferred = ["title", "type", "date", "year", "group", "status",
                         "summary", "snippet", "role", "private",
                         "image", "hero", "aliases", "sources", "tags", "links",
                         "description", "media"];
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for key in preferred.iter() {
            if let Some(v) = obj.get(*key) {
                emit_field(&mut out, key, v);
                seen.insert(*key);
            }
        }
        for (k, v) in obj {
            if !seen.contains(k.as_str()) { emit_field(&mut out, k, v); }
        }
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_start_matches('\n'));
    if !out.ends_with('\n') { out.push('\n'); }
    out
}

fn emit_field(out: &mut String, key: &str, v: &serde_json::Value) {
    match v {
        serde_json::Value::Null => {},
        serde_json::Value::String(s) if s.is_empty() => {},
        serde_json::Value::String(s) => {
            if needs_quoting(s) {
                out.push_str(&format!("{}: \"{}\"\n", key, s.replace('"', "\\\"")));
            } else {
                out.push_str(&format!("{}: {}\n", key, s));
            }
        }
        serde_json::Value::Bool(b) => out.push_str(&format!("{}: {}\n", key, b)),
        serde_json::Value::Number(n) => out.push_str(&format!("{}: {}\n", key, n)),
        serde_json::Value::Array(arr) if arr.is_empty() => {},
        serde_json::Value::Array(arr) => {
            out.push_str(&format!("{}:\n", key));
            for item in arr {
                match item {
                    serde_json::Value::String(s) => out.push_str(&format!("  - {}\n", s)),
                    other => out.push_str(&format!("  - {}\n", other)),
                }
            }
        }
        serde_json::Value::Object(_) => {
            // Nested objects (project.links, gallery.media[]) — emit as JSON for now.
            // Astro YAML is strict-mode YAML, JSON-in-YAML works for these cases.
            out.push_str(&format!("{}: {}\n", key, v));
        }
    }
}

fn needs_quoting(s: &str) -> bool {
    s.contains(':') || s.contains('—') || s.contains('#') || s.starts_with('-')
        || s.contains('"') || s.starts_with(' ') || s.ends_with(' ')
}

fn stringify<E: ToString>(e: E) -> String { e.to_string() }

// ── entry point ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_entries,
            read_entry,
            write_entry,
            run_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
