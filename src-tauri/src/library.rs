use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::{AppHandle, Manager};

/// On Android, copy a file from a `content://` URI (or a plain file path) into
/// `dest` using the Android ContentResolver via JNI.  Falls back to a plain
/// `fs::copy` when the path is not a content URI.
#[cfg(target_os = "android")]
fn copy_to_app_storage(uri_str: &str, dest: &std::path::Path) -> Result<(), String> {
    use std::io::Write;

    // Plain file path — normal copy is sufficient.
    if !uri_str.starts_with("content://") {
        fs::copy(uri_str, dest).map_err(|e| format!("Failed to copy file: {e}"))?;
        return Ok(());
    }

    // content:// URI — must use Android's ContentResolver.
    use jni::objects::{JByteArray, JObject, JValue};

    // SAFETY: Tauri initialises the Android JVM before any commands run;
    //         the pointers stored in ndk_context are therefore valid.
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JVM unavailable: {e}"))?;
    let mut env = vm
        .attach_current_thread_as_daemon()
        .map_err(|e| format!("Cannot attach thread: {e}"))?;

    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };

    let resolver: JObject = env
        .call_method(
            &activity,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("getContentResolver failed: {e}"))?;

    let j_uri_str = env
        .new_string(uri_str)
        .map_err(|e| format!("Failed to create Java string: {e}"))?;
    let uri_obj: JObject = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&j_uri_str)],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("Uri.parse failed: {e}"))?;

    let stream: JObject = env
        .call_method(
            &resolver,
            "openInputStream",
            "(Landroid/net/Uri;)Ljava/io/InputStream;",
            &[JValue::Object(&uri_obj)],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("openInputStream failed: {e}"))?;

    if stream.is_null() {
        return Err(format!("Cannot open content URI: {uri_str}"));
    }

    let jbuf: JByteArray = env
        .new_byte_array(8192)
        .map_err(|e| format!("Failed to allocate JNI buffer: {e}"))?;

    let mut file =
        std::fs::File::create(dest).map_err(|e| format!("Failed to create dest file: {e}"))?;

    loop {
        let n = env
            .call_method(&stream, "read", "([B)I", &[JValue::Object(&*jbuf)])
            .and_then(|v| v.i())
            .map_err(|e| format!("InputStream.read failed: {e}"))?;
        if n <= 0 {
            break;
        }
        let chunk = env
            .convert_byte_array(&jbuf)
            .map_err(|e| format!("convert_byte_array failed: {e}"))?;
        file.write_all(&chunk[..n as usize])
            .map_err(|e| format!("write_all failed: {e}"))?;
    }

    let _ = env.call_method(&stream, "close", "()V", &[]);
    Ok(())
}

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
    pub char_offset: usize,
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
        let id = uuid::Uuid::new_v4().to_string();

        // On Android, copy the file (possibly a content:// URI) into the app's
        // private data directory, named by the book ID so it is always reachable.
        #[cfg(target_os = "android")]
        let stored_path = {
            let dir = app.path().app_data_dir().expect("app data dir unavailable");
            let dest = dir.join(format!("{id}.epub"));
            copy_to_app_storage(&path, &dest)?;
            dest.to_string_lossy().into_owned()
        };

        #[cfg(not(target_os = "android"))]
        let stored_path = path.clone();

        // On desktop deduplicate by stored path; on Android every copy is unique.
        #[cfg(not(target_os = "android"))]
        if lib.books.iter().any(|b| b.path == stored_path) {
            continue;
        }

        let (title, author, description) = parse_epub_meta(&stored_path);
        let book = Book {
            id,
            path: stored_path,
            title,
            author,
            description,
            tags: Vec::new(),
            added_date: chrono::Local::now().format("%Y-%m-%d").to_string(),
            current_chapter: 0,
            char_offset: 0,
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

    // On Android the epub was copied into app storage; clean it up now.
    #[cfg(target_os = "android")]
    if let Some(book) = lib.books.iter().find(|b| b.id == id) {
        let _ = fs::remove_file(&book.path);
    }

    lib.books.retain(|b| b.id != id);
    save_library(&app, &lib)
}

#[tauri::command]
pub fn save_book_progress(
    app: AppHandle,
    id: String,
    chapter: usize,
    char_offset: usize,
) -> Result<(), String> {
    let mut lib = load_library(&app);
    if let Some(book) = lib.books.iter_mut().find(|b| b.id == id) {
        book.current_chapter = chapter;
        book.char_offset = char_offset;
        save_library(&app, &lib)
    } else {
        Err(format!("Book with id {} not found", id))
    }
}
