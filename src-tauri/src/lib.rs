use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::{AppHandle, Manager};
use base64::{Engine, engine::general_purpose::STANDARD};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Book {
    pub id: String,
    pub path: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub tags: Vec<String>,
    pub added_date: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Library {
    books: Vec<Book>,
}

/// Determine the path to the library JSON file, creating parent directories if needed.
fn library_path(app: &AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().expect("app data dir unavailable");
    fs::create_dir_all(&dir).ok();
    dir.join("library.json")
}

/// Load the library from data directory, or return an empty library if the file doesn't exist or is invalid.
fn load_library(app: &AppHandle) -> Library {
    let p = library_path(app);
    if p.exists() {
        let txt = fs::read_to_string(&p).unwrap_or_default();
        serde_json::from_str(&txt).unwrap_or_default()
    } else {
        Library::default()
    }
}

/// Save the library to the data directory, overwriting any existing file.
fn save_library(app: &AppHandle, lib: &Library) -> Result<(), String> {
    let content = serde_json::to_string_pretty(lib).map_err(|e| e.to_string())?;
    fs::write(library_path(app), content).map_err(|e| e.to_string())
}

/// Get the file stem (filename without extension) from a path.
fn filename_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string()
}

/// Strip HTML/XML tags from a string (for descriptions that embed markup).
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for c in s.chars() {
        match c {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Parse title, author, description from an epub file path.
fn parse_epub_meta(path: &str) -> (String, String, String) {
    let fallback = || (filename_stem(path), String::new(), String::new());

    let doc = match epub::doc::EpubDoc::new(path) {
        Ok(doc) => doc,
        Err(_) => return fallback(),
    };

    // Get title - use get_title() if available, otherwise use mdata()
    let title = doc.get_title().unwrap_or_else(|| filename_stem(path));

    // Get author/creator
    let author = doc
        .mdata("creator")
        .map(|m| m.value.as_str())
        .unwrap_or_default()
        .to_string();

    // Get description
    let description = doc
        .mdata("description")
        .map(|m| strip_tags(&m.value))
        .unwrap_or_default();

    (title, author, description)
}

/// Get the content of the current chapter as a string.
/// The resource uris are renamed to have the epub:// prefix and all are relative to the root file
#[tauri::command]
fn get_content(path: &str, chapter: usize) -> Result<String, String> {
    let mut doc = epub::doc::EpubDoc::new(path).map_err(|e| e.to_string())?;

    // Navigate to the specified chapter
    for _ in 0..chapter {
        doc.go_next();
    }

    let current_content = doc
        .get_current_with_epub_uris()
        .map_err(|e| e.to_string())?;
    let content_str = String::from_utf8(current_content).map_err(|e| e.to_string())?;

    Ok(content_str)
}

/// Get the raw bytes of a resource given its path (with epub:// prefix) and the epub file path.
#[tauri::command]
fn get_epub_resource(path: &str, resource_path: &str) -> Result<String, String> {
    let trimmed_resource_path = resource_path.trim_start_matches("epub://");
    let mut doc = epub::doc::EpubDoc::new(path).map_err(|e| e.to_string())?;
    if let Some(resource) = doc.get_resource_by_path(trimmed_resource_path) {
        let base64_resource = STANDARD.encode(&resource);
        return Ok(base64_resource);
    }

    // If all else fails, return an error
    Err(format!("Resource not found: {}", resource_path))
}

#[tauri::command]
fn get_epub_chapters(path: &str) -> Result<usize, String> {
    let doc = epub::doc::EpubDoc::new(path).map_err(|e| e.to_string())?;
    let mut count = 1; // Start with 1 because we're already at chapter 0
    let mut test_doc = doc;

    // Count how many chapters we can advance through
    while test_doc.go_next() {
        count += 1;
    }

    Ok(count)
}

// Tauri commands

#[tauri::command]
fn get_books(app: AppHandle) -> Vec<Book> {
    load_library(&app).books
}

#[tauri::command]
fn add_epub_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<Book>, String> {
    let mut lib = load_library(&app);
    let mut added: Vec<Book> = Vec::new();

    for path in paths {
        if lib.books.iter().any(|b| b.path == path) {
            continue;
        }
        let (title, author, description) = parse_epub_meta(&path);
        let book = Book {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            title,
            author,
            description,
            tags: Vec::new(),
            added_date: chrono::Local::now().format("%Y-%m-%d").to_string(),
        };
        added.push(book.clone());
        lib.books.push(book);
    }

    save_library(&app, &lib)?;
    Ok(added)
}

#[tauri::command]
fn remove_book(app: AppHandle, id: String) -> Result<(), String> {
    let mut lib = load_library(&app);
    lib.books.retain(|b| b.id != id);
    save_library(&app, &lib)
}

/// Main entry point of application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_books,
            add_epub_files,
            remove_book,
            get_content,
            get_epub_resource,
            get_epub_chapters,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
