/**
 * Write `text` to the clipboard, preferring the async Clipboard API and falling
 * back to a hidden-textarea + `execCommand('copy')` for browsers/contexts where
 * `navigator.clipboard` is unavailable (e.g. non-secure origins).
 *
 * Shared by the copy controls (task id, dashboard link, supervisor explanation, share URL).
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
  // `execCommand('copy')` returns false when the copy was blocked (e.g. the
  // command is disabled in the context). Surface that as a rejection so callers
  // don't report a false "Copied" success for a copy that never happened.
  if (!ok) throw new Error('copy command was rejected');
}

/**
 * Read text from the clipboard via the async Clipboard API.
 *
 * Fails closed: returns `null` — never throws — when the API is unavailable
 * (e.g. non-secure origins) or the browser denies/aborts the read. The caller
 * decides what to do with a `null` result. Never logs the clipboard contents.
 */
export async function readClipboardText(): Promise<string | null> {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
