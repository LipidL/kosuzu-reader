import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Book } from "./types.ts";
import { escapeHtml, coverColor, initials } from "./utils.ts";

/** The ID of the book pending for removal */
let pendingRemoveId: string | null = null;

/**
 * Render book list in the UI.
 * If the list is empty, show empty state message.
 * Otherwise, create a card for each book with its cover, title, author, tags, and added date.
 */
export function renderBooks(books: Book[]): void {
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

/**
 * Fetch the list of books from the backend and render them.
 */
export async function loadBooks(): Promise<void> {
    const books: Book[] = await invoke("get_books");
    renderBooks(books);
}

// Cancel removal of a book
document.getElementById("remove-cancel")!.addEventListener("click", () => {
    pendingRemoveId = null;
    document.getElementById("remove-overlay")!.classList.add("hidden");
});

// Confirm removal of a book, then refresh the book list
document.getElementById("remove-confirm")!.addEventListener("click", async () => {
    if (pendingRemoveId) {
        await invoke("remove_book", { id: pendingRemoveId });
        pendingRemoveId = null;
    }
    document.getElementById("remove-overlay")!.classList.add("hidden");
    await loadBooks();
});

// Add books via file picker
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
