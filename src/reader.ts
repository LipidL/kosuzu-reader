import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Book, ChapterData } from "./types.ts";
import { MIME_TYPES } from "./utils.ts";

// Reader state

/** The currently open book, or null if the reader is closed */
let currentBook: Book | null = null;
/** The currently displayed chapter index within the open book */
let currentChapter = 0;
/** Total number of chapters in the open book */
let totalChapters = 0;
/** The currently displayed page index within the current chapter */
let currentPage = 0;
/** Total number of pages in the current chapter */
let totalPages = 1;
/** Whether we should jump to the last page of the next chapter when navigating backward */
let pendingLastPage = false;

/** Per-reader-session chapter cache */
const chapterCache = new Map<number, ChapterData>();
/** Increment to cancel in-flight preloads when navigating or closing */
let preloadGen = 0;

// Internal helpers

/**
 * Replace image sources in the chapter content with data URIs from the resources map.
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
    for (const img of contentDiv.querySelectorAll<SVGImageElement>("image")) {
        const src = img.href.baseVal;
        if (src && resources[src] && !src.startsWith("data:") && !src.startsWith("http")) {
            const ext = src.split(".").pop()?.toLowerCase() ?? "png";
            img.href.baseVal = `data:${MIME_TYPES[ext] ?? "image/png"};base64,${resources[src]}`;
        }
    }
}

/**
 * Strip non-renderable EPUB head elements.
 */
function sanitizeChapterHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("link, title, script, meta").forEach((el) => el.remove());
    return doc.body?.innerHTML ?? html;
}

/**
 * Calculate the dimensions available for rendering chapter content, accounting for padding.
 */
function getPageDims(): { width: number; height: number } {
    const el = document.getElementById("reader-content")!;
    return { width: el.clientWidth, height: el.clientHeight };
}

/**
 * Update the reader navigation UI based on the current chapter and page indices.
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
 * Render a specific chapter page in the reader.
 */
function renderChapter(chapterIndex: number, pageIndex: number, data: ChapterData): void {
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
    currentPage = pageIndex;

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

/**
 * Kick off background preloading of all un-cached chapters,
 * prioritising neighbours of the current chapter.
 */
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

/**
 * Load a specific chapter, using the cache when available.
 */
async function loadChapter(chapterIndex: number): Promise<void> {
    if (!currentBook) return;

    if (chapterCache.has(chapterIndex)) {
        renderChapter(chapterIndex, 0, chapterCache.get(chapterIndex)!);
        startPreloading();
        return;
    }

    try {
        const data = await invoke<ChapterData>("get_chapter_with_resources", {
            path: currentBook.path,
            chapter: chapterIndex,
        });
        chapterCache.set(chapterIndex, data);
        renderChapter(chapterIndex, 0, data);
        startPreloading();
    } catch (e) {
        console.error("Failed to load chapter:", e);
        document.getElementById("reader-content")!.innerHTML =
            `<p>Error loading chapter: ${e}</p>`;
    }
}

/**
 * Save the current reading progress to the backend.
 */
async function saveProgress(): Promise<void> {
    if (currentBook) {
        await invoke("save_book_progress", {
            id: currentBook.id,
            chapter: currentChapter,
            page: currentPage,
        });
    }
}

// Public API

/**
 * Change the current page by a specified direction.
 * @param direction 1 for next page, -1 for previous page
 */
export async function navigatePage(direction: 1 | -1): Promise<void> {
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

/**
 * Open the reader with a specific book.
 */
export async function openReader(book: Book): Promise<void> {
    console.log(`Opening book: ${book.title}, time: ${new Date().toISOString()}`);
    currentBook = book;
    chapterCache.clear();
    preloadGen++;
    document.getElementById("main-content")!.classList.add("hidden");

    const startChapter = book.current_chapter || 0;
    const startPage = book.current_page || 0;

    console.log(`Fetching initial chapter and chapter count for: ${book.title}, time: ${new Date().toISOString()}`);
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

    renderChapter(startChapter, startPage, chapterData);
    console.log(`Rendered initial chapter for: ${book.title}, time: ${new Date().toISOString()}`);

    startPreloading();
}

// Reader event listeners

// Close the reader and save progress
document.getElementById("reader-back-btn")!.addEventListener("click", () => {
    saveProgress().then(() => {
        document.getElementById("reader-view")!.classList.add("hidden");
        document.getElementById("main-content")!.classList.remove("hidden");
        currentBook = null;
        currentChapter = 0;
        currentPage = 0;
        totalPages = 1;
        chapterCache.clear();
        preloadGen++;
    });
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

// Scroll page navigation (except on macOS where it interferes with natural scroll)
document.addEventListener("wheel", (e) => {
    if (!currentBook) return;
    if (navigator.platform.includes("Mac") || e.ctrlKey) return;
    if (Math.abs(e.deltaY) > 30) {
        e.preventDefault();
        navigatePage(e.deltaY > 0 ? 1 : -1);
    }
})

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

// Save progress and destroy the window when it is closed while a book is open
getCurrentWindow().onCloseRequested(async (event) => {
    if (currentBook) {
        event.preventDefault();
        await saveProgress();
    }
    await getCurrentWindow().destroy();
});
