export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}
