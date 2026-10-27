/**
 * The one filename sanitizer shared by the media pipeline and the tool
 * layer. Provider- and model-supplied filenames are metadata, never paths:
 * separators are dropped to the basename, `..` segments and all control
 * bytes are stripped before a name ever reaches a disk path, artifact row
 * or log line. Bounded to the upload contract's 1024-char limit.
 */
export function sanitizeFileName(name: string | undefined, fallback = "attachment"): string {
  const base = (name ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/\.{2,}/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 1024);
  return cleaned.length > 0 ? cleaned : fallback;
}
