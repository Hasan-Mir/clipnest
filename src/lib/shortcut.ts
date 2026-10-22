import type React from "react";
/** Converts a KeyboardEvent into the string format understood by the Rust global-shortcut parser. */
export function eventToShortcut(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = e.code;
  if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  let key = code;
  if (code.startsWith("Key")) key = code.slice(3);
  else if (code.startsWith("Digit")) key = code.slice(5);
  const isF = /^F\d{1,2}$/.test(key);
  if (!mods.length && !isF) return null;
  return [...mods, key].join("+");
}
