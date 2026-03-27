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

// Initialize app
loadBooks();
