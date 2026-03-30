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
/** the currently open book, or null if reader is closed */
let currentBook: Book | null = null;
/** the currently displayed chapter index within the open book */
let currentChapter = 0;
/** total number of chapters in the open book */
let totalChapters = 0;
/** the currently displayed page index within the current chapter */
let currentPage = 0;
/** total number of pages in the current chapter */
let totalPages = 1;
/** whether we should jump to the last page of the next chapter when navigating forward */
let pendingLastPage = false;

interface ChapterData {
    content: string;
    resources: Record<string, string>; // epub:// URI -> base64
}

/** Per-reader-session chapter cache */
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

/**
 * @description Replace image sources in the chapter content with data URIs from the resources map
 * @param contentDiv The container element of the chapter content where <img> tags are located
 * @param resources A mapping of epub:// URIs to base64-encoded image data, used to replace the src attributes of <img> tags in the chapter content
 */
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

// Strip non-renderable EPUB head elements (<link>, <title>, <script>, <meta>)
// that leak into chapter HTML and can cause phantom layout boxes.
function sanitizeChapterHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("link, title, script, meta").forEach((el) => el.remove());
    return doc.body?.innerHTML ?? html;
}


/**
 * @description Calculate the dimensions available for rendering chapter content, accounting for padding.
 * @returns An object containing the width and height available for rendering chapter content
 */
function getPageDims(): { width: number; height: number } {
    const el = document.getElementById("reader-content")!;
    return { width: el.clientWidth, height: el.clientHeight };
}

/**
 * @description Update the reader navigation UI (chapter/page info and prev/next button states) based on the current chapter and page indices
 * @param chapterIndex The index of the currently displayed chapter
 */
function updateReaderNav(chapterIndex: number): void {
    document.getElementById("reader-chapter-info")!.textContent =
        `Ch ${chapterIndex + 1} / ${totalChapters}  ·  Pg ${currentPage + 1} / ${totalPages}`;
    (document.getElementById("reader-prev-btn") as HTMLButtonElement).disabled =
        currentPage === 0 && chapterIndex === 0;
    (document.getElementById("reader-next-btn") as HTMLButtonElement).disabled =
        currentPage >= totalPages - 1 && chapterIndex >= totalChapters - 1;
}

/**
 * @description Render a specific chapter in the reader
 * @param chapterIndex The chapter number to be rendered
 * @param data The data of that chapter
 */
function renderChapter(chapterIndex: number, data: ChapterData): void {
    const pagesDiv = document.getElementById("reader-pages")!;
    const { width: pageWidth, height: pageHeight } = getPageDims();

    pagesDiv.style.transition = "none";
    pagesDiv.style.transform = "translateX(0)";
    pagesDiv.style.height = pageHeight + "px";
    pagesDiv.style.columnWidth = pageWidth + "px";
    pagesDiv.innerHTML = `<div class="page-content">${sanitizeChapterHtml(data.content)}</div>`;
    applyResourcesToImages(pagesDiv, data.resources);

    // Compute the max image height: available content area minus the image's
    // own vertical margins (which are NOT included in max-height but DO add
    // to the flow height, causing overflow into a phantom column).
    const pc = pagesDiv.firstElementChild as HTMLElement;
    const pcStyle = getComputedStyle(pc);
    const availH = pageHeight - parseFloat(pcStyle.paddingTop) - parseFloat(pcStyle.paddingBottom);
    const sampleImg = pagesDiv.querySelector<HTMLImageElement>("img");
    let imgMarginV = 0;
    if (sampleImg) {
        const is = getComputedStyle(sampleImg);
        imgMarginV = parseFloat(is.marginTop) + parseFloat(is.marginBottom);
    }
    pagesDiv.style.setProperty("--page-img-max-h", Math.max(Math.floor(availH - imgMarginV), 64) + "px");

    currentChapter = chapterIndex;
    currentPage = 0;

    // Double RAF: first pass lets the browser lay out columns,
    // second pass ensures scrollWidth is accurate before we read it.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            totalPages = Math.max(1, Math.round(pagesDiv.scrollWidth / pageWidth));
            console.log(`Chapter ${chapterIndex}: calculated totalPages = ${totalPages}, scrollWidth = ${pagesDiv.scrollWidth}, pageWidth = ${pageWidth}`);
            if (pendingLastPage) {
                currentPage = totalPages - 1;
                pendingLastPage = false;
            }
            pagesDiv.style.transition = "none";
            pagesDiv.style.transform = `translateX(${-currentPage * pageWidth}px)`;
            requestAnimationFrame(() => { pagesDiv.style.transition = ""; });
            updateReaderNav(chapterIndex);
        });
    });
}

async function navigatePage(direction: 1 | -1): Promise<void> {
    const pagesDiv = document.getElementById("reader-pages")!;
    const { width: pageWidth } = getPageDims();

    const newPage = currentPage + direction;
    if (newPage >= 0 && newPage < totalPages) {
        currentPage = newPage;
        pagesDiv.style.transform = `translateX(${-currentPage * pageWidth}px)`;
        updateReaderNav(currentChapter);
    } else if (direction > 0 && currentChapter < totalChapters - 1) {
        await loadChapter(currentChapter + 1);
    } else if (direction < 0 && currentChapter > 0) {
        pendingLastPage = true;
        await loadChapter(currentChapter - 1);
    }
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
    // Show the reader view BEFORE rendering so clientWidth/clientHeight are non-zero
    document.getElementById("reader-view")!.classList.remove("hidden");
    document.getElementById("reader-title")!.textContent = book.title;
    console.log(`Displayed reader view for: ${book.title}, time: ${new Date().toISOString()}`);

    renderChapter(startChapter, chapterData);
    console.log(`Rendered initial chapter for: ${book.title}, time: ${new Date().toISOString()}`);

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
    currentPage = 0;
    totalPages = 1;
    chapterCache.clear();
    preloadGen++; // cancel any in-flight preloads
});

document.getElementById("reader-prev-btn")!.addEventListener("click", () => navigatePage(-1));
document.getElementById("reader-next-btn")!.addEventListener("click", () => navigatePage(1));

// Keyboard page navigation
document.addEventListener("keydown", (e) => {
    if (!currentBook) return;
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        navigatePage(1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        navigatePage(-1);
    }
});

// Recalculate pages on resize
window.addEventListener("resize", () => {
    if (!currentBook) return;
    const pagesDiv = document.getElementById("reader-pages")!;
    const { width: pageWidth, height: pageHeight } = getPageDims();
    pagesDiv.style.height = pageHeight + "px";
    pagesDiv.style.columnWidth = pageWidth + "px";
    const pcResize = pagesDiv.firstElementChild as HTMLElement | null;
    if (pcResize) {
        const s = getComputedStyle(pcResize);
        const availH = pageHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
        const sampleImg = pagesDiv.querySelector<HTMLImageElement>("img");
        let imgMarginV = 0;
        if (sampleImg) {
            const is = getComputedStyle(sampleImg);
            imgMarginV = parseFloat(is.marginTop) + parseFloat(is.marginBottom);
        }
        pagesDiv.style.setProperty("--page-img-max-h", Math.max(Math.floor(availH - imgMarginV), 64) + "px");
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            totalPages = Math.max(1, Math.round(pagesDiv.scrollWidth / pageWidth));
            currentPage = Math.min(currentPage, totalPages - 1);
            pagesDiv.style.transition = "none";
            pagesDiv.style.transform = `translateX(${-currentPage * pageWidth}px)`;
            requestAnimationFrame(() => { pagesDiv.style.transition = ""; });
            updateReaderNav(currentChapter);
        });
    });
});

// Swipe to navigate pages
{
    let touchStartX = 0;
    const readerContent = document.getElementById("reader-content")!;
    readerContent.addEventListener("touchstart", (e) => {
        touchStartX = e.touches[0].clientX;
    }, { passive: true });
    readerContent.addEventListener("touchend", (e) => {
        if (!currentBook) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(dx) > 50) navigatePage(dx < 0 ? 1 : -1);
    }, { passive: true });
}

// Initialize app
loadBooks();
