export interface Book {
    id: string;
    path: string;
    title: string;
    author: string;
    description: string;
    tags: string[];
    added_date: string;
    current_chapter: number;
    char_offset: number;
}

export interface ChapterData {
    content: string;
    resources: Record<string, string>; // epub:// URI -> base64
}
