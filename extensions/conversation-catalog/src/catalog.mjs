function text(value) {
  return typeof value === "string" ? value : "";
}

/** Escapes locally rendered report text; it never evaluates session content. */
export function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}
