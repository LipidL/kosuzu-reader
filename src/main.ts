import { invoke } from "@tauri-apps/api/core";
import { loadBooks } from "./library.ts";
import { openReader } from "./reader.ts";
import { Book } from "./types.ts";

// Open the reader when the user clicks a book card
document.getElementById("book-grid")!.addEventListener("click", async (e) => {
    const card = (e.target as HTMLElement).closest(".book-card") as HTMLElement;
    if (!card) return;
    const id = card.dataset.id;
    if (!id) return;

    const books: Book[] = await invoke("get_books");
    const book = books.find((b) => b.id === id);
    if (!book) return;

    openReader(book);
});

// Initialize app
loadBooks();

