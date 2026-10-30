export interface Page<T> {
  items: T[];
  next?: string;
}

export function paginate<T>(items: T[], cursor: string | undefined, size = 20): Page<T> {
  const start = cursor === undefined ? 0 : Number(cursor);
  const end = start + size;
  return { items: items.slice(start, end), ...(end < items.length ? { next: String(end) } : {}) };
}
