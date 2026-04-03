export const COVER_PALETTE = [
    "#4a6fa5", "#e07b54", "#5a9478", "#7b68a5",
    "#c26555", "#4d8a8a", "#8a5ea5", "#a57b4a",
    "#6a7fad", "#c49a3c",
];

export const MIME_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
};

/**
 * Escape special HTML characters in a string to prevent XSS vulnerabilities
 * when rendering user-generated content such as book titles, authors, and tags in the UI.
 */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Generate a consistent color for a book cover based on its title.
 */
export function coverColor(title: string): string {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
        hash = (Math.imul(31, hash) + title.charCodeAt(i)) | 0;
    }
    return COVER_PALETTE[Math.abs(hash) % COVER_PALETTE.length];
}

/**
 * Get initials (up to two words) for a book title.
 */
export function initials(title: string): string {
    return title
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => (w[0] ?? "").toUpperCase())
        .join("");
}
