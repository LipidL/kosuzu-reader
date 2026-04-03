use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Book {
    pub id: String,
    pub path: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub tags: Vec<String>,
    pub added_date: String,
    pub current_chapter: usize,
    pub current_page: usize,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Library {
    pub books: Vec<Book>,
}

/// Determine the path to the library JSON file, creating parent directories if needed.
fn library_path(app: &AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().expect("app data dir unavailable");
    fs::create_dir_all(&dir).ok();
    dir.join("library.toml")
}

/// Load the library from data directory, or return an empty library if the file doesn't exist or is invalid.
pub fn load_library(app: &AppHandle) -> Library {
    let p = library_path(app);
    if p.exists() {
        let txt = fs::read_to_string(&p).unwrap_or_default();
        toml::from_str(&txt).unwrap_or_default()
    } else {
        Library::default()
    }
}

/// Save the library to the data directory, overwriting any existing file.
pub fn save_library(app: &AppHandle, lib: &Library) -> Result<(), String> {
    let content = toml::to_string_pretty(lib).map_err(|e| e.to_string())?;
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
pub fn parse_epub_meta(path: &str) -> (String, String, String) {
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

#[tauri::command]
pub fn get_books(app: AppHandle) -> Vec<Book> {
    load_library(&app).books
}

#[tauri::command]
pub fn add_epub_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<Book>, String> {
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
            current_chapter: 0,
            current_page: 0,
        };
        added.push(book.clone());
        lib.books.push(book);
    }

    save_library(&app, &lib)?;
    Ok(added)
}

#[tauri::command]
pub fn remove_book(app: AppHandle, id: String) -> Result<(), String> {
    let mut lib = load_library(&app);
    lib.books.retain(|b| b.id != id);
    save_library(&app, &lib)
}

#[tauri::command]
pub fn save_book_progress(app: AppHandle, id: String, chapter: usize, page: usize) -> Result<(), String> {
    let mut lib = load_library(&app);
    if let Some(book) = lib.books.iter_mut().find(|b| b.id == id) {
        book.current_chapter = chapter;
        book.current_page = page;
        save_library(&app, &lib)
    } else {
        Err(format!("Book with id {} not found", id))
    }
}