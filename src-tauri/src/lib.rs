use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};
use tauri::{AppHandle, Manager};

// ── Data model ──────────────────────────────────────────────────────────────

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

// ── Persistence ──────────────────────────────────────────────────────────────

fn library_path(app: &AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().expect("app data dir unavailable");
    fs::create_dir_all(&dir).ok();
    dir.join("library.json")
}

fn load_library(app: &AppHandle) -> Library {
    let p = library_path(app);
    if p.exists() {
        let txt = fs::read_to_string(&p).unwrap_or_default();
        serde_json::from_str(&txt).unwrap_or_default()
    } else {
        Library::default()
    }
}

fn save_library(app: &AppHandle, lib: &Library) -> Result<(), String> {
    let content = serde_json::to_string_pretty(lib).map_err(|e| e.to_string())?;
    fs::write(library_path(app), content).map_err(|e| e.to_string())
}

// ── EPUB metadata parsing ────────────────────────────────────────────────────

fn filename_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string()
}

/// Extract the OPF rootfile path from META-INF/container.xml content.
fn opf_path_from_container(xml: &str) -> Option<String> {
    let marker = "full-path=\"";
    let start = xml.find(marker)? + marker.len();
    let end = xml[start..].find('"')? + start;
    Some(xml[start..end].to_string())
}

/// Extract the text content of the first matching XML element (handles attributes on open tag).
fn xml_tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open_prefix = format!("<{}", tag);
    let close_tag = format!("</{}>", tag);
    let tag_start = xml.find(&open_prefix)?;
    let content_start = xml[tag_start..].find('>')? + tag_start + 1;
    let end = xml[content_start..].find(&close_tag)? + content_start;
    let s = xml[content_start..end].trim();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
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

    let f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return fallback(),
    };
    let mut archive = match zip::ZipArchive::new(f) {
        Ok(a) => a,
        Err(_) => return fallback(),
    };

    // Find OPF path via container.xml
    let opf_path = {
        let mut entry = match archive.by_name("META-INF/container.xml") {
            Ok(e) => e,
            Err(_) => return fallback(),
        };
        let mut buf = String::new();
        entry.read_to_string(&mut buf).ok();
        match opf_path_from_container(&buf) {
            Some(p) => p,
            None => return fallback(),
        }
    };

    // Read OPF file
    let opf = {
        let mut entry = match archive.by_name(&opf_path) {
            Ok(e) => e,
            Err(_) => return fallback(),
        };
        let mut buf = String::new();
        entry.read_to_string(&mut buf).ok();
        buf
    };

    let title = xml_tag_text(&opf, "dc:title")
        .map(str::to_string)
        .unwrap_or_else(|| filename_stem(path));
    let author = xml_tag_text(&opf, "dc:creator")
        .map(str::to_string)
        .unwrap_or_default();
    let description = xml_tag_text(&opf, "dc:description")
        .map(|s| strip_tags(s))
        .unwrap_or_default();

    (title, author, description)
}

// ── Tauri commands ───────────────────────────────────────────────────────────

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

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_books,
            add_epub_files,
            remove_book
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
