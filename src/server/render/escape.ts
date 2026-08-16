const REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll(/[&<>"']/g, (character) => REPLACEMENTS[character] ?? character)
}

export function attribute(value: unknown): string {
  return escapeHtml(value)
}

export function jsonAttribute(value: unknown): string {
  return escapeHtml(JSON.stringify(value))
}
