export function shouldSkipPage(doc: Document = document): boolean {
  if (doc.hidden) return true;
  if (doc.fullscreenElement) return true;

  const active = doc.activeElement as HTMLElement | null;
  if (
    active &&
    (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
  ) {
    return true;
  }

  const selection = doc.defaultView?.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    return true;
  }
  return false;
}
