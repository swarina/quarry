/**
 * Small helpers for building DOM. Everything a board wrote (titles, companies, labels) goes in
 * as text, never as markup, so a posting can never inject anything into the page.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Partial<Record<string, string | boolean | number>> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined || value === false) continue;
    if (name === "class") node.className = String(value);
    else if (name === "text") node.textContent = String(value);
    else if (value === true) node.setAttribute(name, "");
    else node.setAttribute(name, String(value));
  }
  node.append(...children);
  return node;
}

/** Replaces everything inside a node. */
export function fill(node: Element, children: readonly (Node | string)[]): void {
  node.replaceChildren(...children);
}

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page has no #${id}`);
  return node as T;
}
