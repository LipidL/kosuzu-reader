use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

/// Holds the HTML content of a chapter together with all embedded resources
/// (images, etc.) encoded as base64 strings, keyed by their epub:// URI.
#[derive(Serialize, Deserialize)]
pub struct ChapterData {
    pub content: String,
    pub resources: std::collections::HashMap<String, String>,
}

/// Scan a content string for every distinct `epub://…` URI.
fn extract_epub_uris(content: &str) -> Vec<String> {
    let mut uris: Vec<String> = Vec::new();
    let mut rest = content;
    while let Some(pos) = rest.find("epub://") {
        let slice = &rest[pos..];
        let end = slice
            .find(|c: char| ['"', '\'', ' ', '\n', '\t', '>'].contains(&c))
            .unwrap_or(slice.len());
        let uri = &slice[..end];
        if !uris.iter().any(|u| u == uri) {
            uris.push(uri.to_string());
        }
        rest = &rest[pos + 7..];
    }
    uris
}

/// Return the HTML content of a chapter together with all embedded resources
/// pre-fetched as base64 strings.  A single epub file open covers both the
/// content and all resource fetches, eliminating per-image round-trips.
#[tauri::command]
pub fn get_chapter_with_resources(path: &str, chapter: usize) -> Result<ChapterData, String> {
    let mut doc = epub::doc::EpubDoc::new(path).map_err(|e| e.to_string())?;

    for _ in 0..chapter {
        doc.go_next();
    }

    let raw = doc
        .get_current_with_epub_uris()
        .map_err(|e| e.to_string())?;
    let content = String::from_utf8(raw).map_err(|e| e.to_string())?;

    let mut resources = std::collections::HashMap::new();
    for uri in extract_epub_uris(&content) {
        let trimmed = uri.trim_start_matches("epub://");
        if let Some(data) = doc.get_resource_by_path(trimmed) {
            resources.insert(uri, STANDARD.encode(&data));
        }
    }

    Ok(ChapterData { content, resources })
}

/// Get the content of the current chapter as a string.
/// The resource uris are renamed to have the epub:// prefix and all are relative to the root file
#[tauri::command]
pub fn get_content(path: &str, chapter: usize) -> Result<String, String> {
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
pub fn get_epub_resource(path: &str, resource_path: &str) -> Result<String, String> {
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
pub fn get_epub_chapters(path: &str) -> Result<usize, String> {
    let doc = epub::doc::EpubDoc::new(path).map_err(|e| e.to_string())?;
    let mut count = 1; // Start with 1 because we're already at chapter 0
    let mut test_doc = doc;

    // Count how many chapters we can advance through
    while test_doc.go_next() {
        count += 1;
    }

    Ok(count)
}
