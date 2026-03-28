import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface Book {
    id: string;
    path: string;
    title: string;
    author: string;
    description: string;
    tags: string[];
    added_date: string;
}

// Helpers 

// Simple HTML escaping to prevent XSS in book titles/authors/tags
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const COVER_PALETTE = [
    "#4a6fa5", "#e07b54", "#5a9478", "#7b68a5",
    "#c26555", "#4d8a8a", "#8a5ea5", "#a57b4a",
    "#6a7fad", "#c49a3c",
];

// Generate a consistent color for a book cover based on its title
function coverColor(title: string): string {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
        hash = (Math.imul(31, hash) + title.charCodeAt(i)) | 0;
    }
    return COVER_PALETTE[Math.abs(hash) % COVER_PALETTE.length];
}

// Get initials from the book title
function initials(title: string): string {
    return title
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => (w[0] ?? "").toUpperCase())
        .join("");
}

// Rendering

// Render the list of books in the UI
function renderBooks(books: Book[]): void {
    const grid = document.getElementById("book-grid")!;
    const empty = document.getElementById("empty-state")!;

    if (books.length === 0) {
        empty.classList.remove("hidden");
        grid.innerHTML = "";
        return;
    }

    empty.classList.add("hidden");
    grid.innerHTML = books
        .map(
            (b) => `
    <article class="book-card" data-id="${b.id}">
      <div class="book-cover" style="background:${coverColor(b.title)}">
        <span class="book-initials">${escapeHtml(initials(b.title))}</span>
      </div>
      <div class="book-info">
        <h3 class="book-title" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</h3>
        <p class="book-author">${escapeHtml(b.author || "Unknown Author")}</p>
        ${b.tags.length > 0
                    ? `<div class="book-tags">${b.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>`
                    : ""
                }
        <p class="book-date">Added ${escapeHtml(b.added_date)}</p>
      </div>
      <button class="remove-btn" data-id="${b.id}" aria-label="Remove book" title="Remove">✕</button>
    </article>`
        )
        .join("");

    grid.querySelectorAll<HTMLButtonElement>(".remove-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            pendingRemoveId = btn.dataset.id ?? null;
            document.getElementById("remove-overlay")!.classList.remove("hidden");
        });
    });
}

// Get the list of books and render them
async function loadBooks(): Promise<void> {
    const books: Book[] = await invoke("get_books");
    renderBooks(books);
}

// Remove dialog
let pendingRemoveId: string | null = null;

document.getElementById("remove-cancel")!.addEventListener("click", () => {
    pendingRemoveId = null;
    document.getElementById("remove-overlay")!.classList.add("hidden");
});

document.getElementById("remove-confirm")!.addEventListener("click", async () => {
    if (pendingRemoveId) {
        await invoke("remove_book", { id: pendingRemoveId });
        pendingRemoveId = null;
    }
    document.getElementById("remove-overlay")!.classList.add("hidden");
    await loadBooks();
});

// Add books
document.getElementById("add-books-btn")!.addEventListener("click", async () => {
    const selected = await open({
        multiple: true,
        filters: [{ name: "EPUB Files", extensions: ["epub"] }],
    });

    if (!selected) return;
    const paths: string[] = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;

    await invoke("add_epub_files", { paths });
    await loadBooks();
});

// Get book content when the user clicks on a book card
document.getElementById("book-grid")!.addEventListener("click", async (e) => {
    const card = (e.target as HTMLElement).closest(".book-card") as HTMLElement;
    if (!card) return;
    const id = card.dataset.id;
    if (!id) return;

    const books: Book[] = await invoke("get_books");
    const book = books.find((b) => b.id === id);
    if (!book) return;

    // Open the reader
    openReader(book);
});

// Reader state
let currentBook: Book | null = null;
let currentChapter = 0;
let totalChapters = 0;

// Open reader with a specific book
async function openReader(book: Book): Promise<void> {
    currentBook = book;
    currentChapter = 0;

    // Get total chapters
    const chapters: number = await invoke("get_epub_chapters", { path: book.path });
    totalChapters = chapters;

    // Hide main content and show reader
    document.getElementById("main-content")!.classList.add("hidden");
    document.getElementById("reader-view")!.classList.remove("hidden");
    document.getElementById("reader-title")!.textContent = book.title;

    // Load first chapter
    await loadChapter(0);
}

// Load a specific chapter
async function loadChapter(chapterIndex: number): Promise<void> {
    if (!currentBook) return;

    try {
        const content: string = await invoke("get_content", {
            path: currentBook.path,
            chapter: chapterIndex,
        });

        const contentDiv = document.getElementById("reader-content")!;
        contentDiv.innerHTML = content;

        // Update chapter info
        document.getElementById("reader-chapter-info")!.textContent = `${chapterIndex + 1} / ${totalChapters}`;

        // Update button states
        const prevBtn = document.getElementById("reader-prev-btn")! as HTMLButtonElement;
        const nextBtn = document.getElementById("reader-next-btn")! as HTMLButtonElement;
        prevBtn.disabled = chapterIndex === 0;
        nextBtn.disabled = chapterIndex >= totalChapters - 1;

        // Load images with resource fetching
        const images = contentDiv.querySelectorAll<HTMLImageElement>("img");
        for (const img of images) {
            const src = img.getAttribute("src");
            if (src && !src.startsWith("data:") && !src.startsWith("http")) {
                try {
                    console.log(`Loading resource: ${src}, time: ${new Date().toISOString()}`);
                    const resourceData: String = await invoke("get_epub_resource", {
                        path: currentBook.path,
                        resourcePath: src,
                    });
                    console.log(`Resource loaded: ${src}, size: ${resourceData.length} bytes, time: ${new Date().toISOString()}`);

                    // Detect mime type from the file extension
                    const ext = src.split('.').pop()?.toLowerCase() || 'png';
                    const mimeType = {
                        'png': 'image/png',
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'gif': 'image/gif',
                        'webp': 'image/webp',
                        'svg': 'image/svg+xml',
                    }[ext] || 'image/png';

                    img.src = `data:${mimeType};base64,${resourceData}`;
                    console.log(`Image src set for ${src}, time: ${new Date().toISOString()}`);
                } catch (e) {
                    console.warn(`Failed to load resource: ${src}`, e);
                    // Leave the original broken image as-is
                }
            }
        }

        currentChapter = chapterIndex;
    } catch (e) {
        console.error("Failed to load chapter:", e);
        document.getElementById("reader-content")!.innerHTML = `<p>Error loading chapter: ${e}</p>`;
    }
}

// Reader controls
document.getElementById("reader-back-btn")!.addEventListener("click", () => {
    document.getElementById("reader-view")!.classList.add("hidden");
    document.getElementById("main-content")!.classList.remove("hidden");
    currentBook = null;
    currentChapter = 0;
});

document.getElementById("reader-prev-btn")!.addEventListener("click", async () => {
    if (currentChapter > 0) {
        await loadChapter(currentChapter - 1);
    }
});

document.getElementById("reader-next-btn")!.addEventListener("click", async () => {
    if (currentChapter < totalChapters - 1) {
        await loadChapter(currentChapter + 1);
    }
});


// Initialize app
loadBooks();
