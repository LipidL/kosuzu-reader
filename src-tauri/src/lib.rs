mod library;
mod book;

// Tauri commands

/// Main entry point of application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            library::get_books,
            library::add_epub_files,
            library::remove_book,
            library::save_book_progress,
            book::get_content,
            book::get_epub_resource,
            book::get_epub_chapters,
            book::get_chapter_with_resources,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
