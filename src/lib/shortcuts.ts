export type ShortcutId =
  | "addFiles"
  | "addFolder"
  | "settings"
  | "rotateLeft"
  | "rotateRight"
  | "remove"
  | "moveUp"
  | "moveDown"
  | "moveTop"
  | "moveBottom"
  | "viewOriginal"
  | "viewResult"
  | "viewMask"
  | "viewCompare"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit"
  | "undo"
  | "redo"
  | "editorKeep"
  | "editorRemove"
  | "editorPan"
  | "editorTemporaryPan"
  | "editorBrushSmaller"
  | "editorBrushLarger";

interface ShortcutDefinition {
  key: string;
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
  displayKey?: string;
}

type KeyboardLikeEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { code?: string };

const SHORTCUTS: Record<ShortcutId, ShortcutDefinition> = {
  addFiles: { key: "o", primary: true },
  addFolder: { key: "o", primary: true, shift: true },
  settings: { key: ",", primary: true },
  rotateLeft: { key: "arrowleft", alt: true, displayKey: "←" },
  rotateRight: { key: "arrowright", alt: true, displayKey: "→" },
  remove: { key: "delete", displayKey: "Delete" },
  moveUp: { key: "arrowup", alt: true, displayKey: "↑" },
  moveDown: { key: "arrowdown", alt: true, displayKey: "↓" },
  moveTop: { key: "home", alt: true, displayKey: "Home" },
  moveBottom: { key: "end", alt: true, displayKey: "End" },
  viewOriginal: { key: "1" },
  viewResult: { key: "2" },
  viewMask: { key: "3" },
  viewCompare: { key: "4" },
  zoomIn: { key: "+", primary: true, displayKey: "+" },
  zoomOut: { key: "-", primary: true, displayKey: "−" },
  zoomFit: { key: "0", primary: true },
  undo: { key: "z", primary: true },
  redo: { key: "z", primary: true, shift: true },
  editorKeep: { key: "b" },
  editorRemove: { key: "e" },
  editorPan: { key: "h" },
  editorTemporaryPan: { key: " ", displayKey: "Space" },
  editorBrushSmaller: { key: "[" },
  editorBrushLarger: { key: "]" },
};

export const isMacPlatform = () => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
};

export const matchesShortcut = (event: KeyboardLikeEvent, shortcutId: ShortcutId) => {
  const shortcut = SHORTCUTS[shortcutId];
  const primaryPressed = event.ctrlKey || event.metaKey;
  const normalizedKey = event.key.toLowerCase();
  const keyMatches = shortcutId === "zoomIn"
    ? normalizedKey === "+" || normalizedKey === "="
    : shortcutId === "editorBrushSmaller"
      ? normalizedKey === "[" || event.code === "BracketLeft"
      : shortcutId === "editorBrushLarger"
        ? normalizedKey === "]" || event.code === "BracketRight"
        : normalizedKey === shortcut.key;

  return keyMatches
    && primaryPressed === Boolean(shortcut.primary)
    && event.altKey === Boolean(shortcut.alt)
    && event.shiftKey === Boolean(shortcut.shift);
};

export const formatShortcut = (shortcutId: ShortcutId, mac = isMacPlatform()) => {
  const shortcut = SHORTCUTS[shortcutId];
  const parts: string[] = [];
  if (shortcut.primary) parts.push(mac ? "Cmd" : "Ctrl");
  if (shortcut.alt) parts.push(mac ? "Option" : "Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(shortcut.displayKey ?? shortcut.key.toUpperCase());
  return parts.join("+");
};

export const ariaShortcut = (shortcutId: ShortcutId) => {
  const shortcut = SHORTCUTS[shortcutId];
  const parts: string[] = [];
  if (shortcut.primary) parts.push(isMacPlatform() ? "Meta" : "Control");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  const key = shortcut.key.startsWith("arrow")
    ? `Arrow${shortcut.key.slice(5, 6).toUpperCase()}${shortcut.key.slice(6)}`
    : shortcut.key === "delete" ? "Delete"
      : shortcutId === "editorTemporaryPan" ? "Space"
        : shortcut.key;
  parts.push(key);
  return parts.join("+");
};
