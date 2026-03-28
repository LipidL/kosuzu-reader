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

interface ChapterData {
    content: string;
    resources: Record<string, string>; // epub:// URI -> base64
}

// Per-reader-session chapter cache
const chapterCache = new Map<number, ChapterData>();
// Increment to cancel in-flight preloads when navigating or closing
let preloadGen = 0;

const MIME_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
};

function applyResourcesToImages(
    contentDiv: HTMLElement,
    resources: Record<string, string>,
): void {
    for (const img of contentDiv.querySelectorAll<HTMLImageElement>("img")) {
        const src = img.getAttribute("src");
        if (src && resources[src] && !src.startsWith("data:") && !src.startsWith("http")) {
            const ext = src.split(".").pop()?.toLowerCase() ?? "png";
            img.src = `data:${MIME_TYPES[ext] ?? "image/png"};base64,${resources[src]}`;
        }
    }
}

function renderChapter(chapterIndex: number, data: ChapterData): void {
    const contentDiv = document.getElementById("reader-content")!;
    contentDiv.innerHTML = data.content;
    applyResourcesToImages(contentDiv, data.resources);

    document.getElementById("reader-chapter-info")!.textContent =
        `${chapterIndex + 1} / ${totalChapters}`;
    (document.getElementById("reader-prev-btn") as HTMLButtonElement).disabled =
        chapterIndex === 0;
    (document.getElementById("reader-next-btn") as HTMLButtonElement).disabled =
        chapterIndex >= totalChapters - 1;

    contentDiv.scrollTop = 0;
    currentChapter = chapterIndex;
}

// Kick off background preloading of all un-cached chapters, prioritising
// neighbours of the current chapter.
function startPreloading(): void {
    if (!currentBook) return;
    preloadGen++;
    const gen = preloadGen;
    const book = currentBook;

    const queue: number[] = [];
    for (let delta = 1; delta < totalChapters; delta++) {
        const next = currentChapter + delta;
        const prev = currentChapter - delta;
        if (next < totalChapters && !chapterCache.has(next)) queue.push(next);
        if (prev >= 0 && !chapterCache.has(prev)) queue.push(prev);
    }

    (async () => {
        for (const idx of queue) {
            if (preloadGen !== gen || currentBook !== book) return;
            if (chapterCache.has(idx)) continue;
            try {
                const data = await invoke<ChapterData>("get_chapter_with_resources", {
                    path: book.path,
                    chapter: idx,
                });
                if (preloadGen === gen) chapterCache.set(idx, data);
            } catch (e) {
                console.warn(`Preload chapter ${idx} failed:`, e);
            }
        }
    })();
}

// Open reader with a specific book
async function openReader(book: Book): Promise<void> {
    console.log(`Opening book: ${book.title}, time: ${new Date().toISOString()}`);
    currentBook = book;
    currentChapter = 0; // TODO: restore saved progress
    chapterCache.clear();
    preloadGen++;
    document.getElementById("main-content")!.classList.add("hidden");

    // Fetch chapter count and first-chapter content+resources in parallel
    console.log(`Fetching initial chapter and chapter count for: ${book.title}, time: ${new Date().toISOString()}`);
    const startChapter = 0;
    const [chapters, chapterData] = await Promise.all([
        invoke<number>("get_epub_chapters", { path: book.path }),
        invoke<ChapterData>("get_chapter_with_resources", {
            path: book.path,
            chapter: startChapter,
        }),
    ]);
    console.log(`Fetched initial chapter and chapter count for: ${book.title}, time: ${new Date().toISOString()}`);

    totalChapters = chapters;
    chapterCache.set(startChapter, chapterData);
    renderChapter(startChapter, chapterData);
    console.log(`Rendered initial chapter for: ${book.title}, time: ${new Date().toISOString()}`);

    document.getElementById("reader-view")!.classList.remove("hidden");
    document.getElementById("reader-title")!.textContent = book.title;
    console.log(`Displayed reader view for: ${book.title}, time: ${new Date().toISOString()}`);

    // Kick off background preloading for all remaining chapters
    startPreloading();
}

// Load a specific chapter, using the cache when available
async function loadChapter(chapterIndex: number): Promise<void> {
    if (!currentBook) return;

    if (chapterCache.has(chapterIndex)) {
        renderChapter(chapterIndex, chapterCache.get(chapterIndex)!);
        startPreloading();
        return;
    }

    try {
        const data = await invoke<ChapterData>("get_chapter_with_resources", {
            path: currentBook.path,
            chapter: chapterIndex,
        });
        chapterCache.set(chapterIndex, data);
        renderChapter(chapterIndex, data);
        startPreloading();
    } catch (e) {
        console.error("Failed to load chapter:", e);
        document.getElementById("reader-content")!.innerHTML =
            `<p>Error loading chapter: ${e}</p>`;
    }
}

// Reader controls
document.getElementById("reader-back-btn")!.addEventListener("click", () => {
    document.getElementById("reader-view")!.classList.add("hidden");
    document.getElementById("main-content")!.classList.remove("hidden");
    currentBook = null;
    currentChapter = 0;
    chapterCache.clear();
    preloadGen++; // cancel any in-flight preloads
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
