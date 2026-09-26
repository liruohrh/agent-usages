/**
 * Handing a file or a URL to the desktop.
 *
 * Two commands open things — `usage --open` (the rendered report) and
 * `serve --open` (the platform) — and both want the same two properties: a
 * machine with no browser is not an error, and a script can say "never".
 *
 * `AGENT_USAGES_NO_BROWSER=1` is that "never": it is what a CI run, a remote
 * shell or a test suite sets, so nothing tries to reach a desktop that is not
 * there.
 */

/**
 * Open a path or URL in the default browser.
 * @param target - the file or URL to show.
 * @returns whether a browser was asked to open it.
 */
export async function openInBrowser(target: string): Promise<boolean> {
  if (process.env['AGENT_USAGES_NO_BROWSER'] === '1') return false;
  try {
    const { default: open } = await import('open');
    await open(target);
    return true;
  } catch {
    // No browser, no desktop session, or the launcher refused: the caller has
    // already printed where the file went, and that is the part that matters.
    return false;
  }
}
