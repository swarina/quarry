import { decodeHTML } from "entities/decode";

type HtmlToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "open"; readonly name: string }
  | { readonly kind: "close"; readonly name: string };

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
]);
const LIST = new Set(["ol", "ul"]);
const CELL = new Set(["td", "th"]);
const WRAPPER = new Set(["div", "p"]);

/** Elements whose content is never posting text. */
const SKIPPED = new Map(
  ["noscript", "script", "style", "svg", "template", "title"].map((name) => [
    name,
    new RegExp(`</${name}[\\s/>]`, "gi"),
  ]),
);

/**
 * Converts posting HTML to plain text the way a browser lays it out: blocks become paragraphs,
 * list items become `- ` lines (nested lists are flattened), `<br>` becomes a line break, and
 * source whitespace collapses. Entities are decoded inside text only, so `&lt;b&gt;` stays text.
 * The result is NFC-normalized, with no blank-line runs and no padding on any line.
 *
 * Runs in linear time, including on malformed or adversarial markup. Input must already be
 * HTML; adapters for ATSs that escape their markup (Greenhouse) decode it first.
 */
export function htmlToText(html: string): string {
  let output = "";
  let hasText = false;
  let pendingBreak: 0 | 1 | 2 = 0;
  let bulletPending = false;
  // One entry per open list: whether a list item is open in it. `openItems` counts the trues.
  const lists: boolean[] = [];
  let openItems = 0;
  const inListItem = () => openItems > 0;
  const setItemOpen = (open: boolean) => {
    if (lists.length === 0) lists.push(false);
    const last = lists.length - 1;
    if (lists[last] !== open) openItems += open ? 1 : -1;
    lists[last] = open;
  };
  const requestBreak = (level: 1 | 2) => {
    if (level > pendingBreak) pendingBreak = level;
  };

  for (const token of tokenizeHtml(html)) {
    if (token.kind === "text") {
      const text = decodeHTML(token.text).replace(/\s+/g, " ");
      if (text.trim() === "") {
        output += text;
        continue;
      }
      if (pendingBreak > 0 && hasText) output += pendingBreak === 2 ? "\n\n" : "\n";
      pendingBreak = 0;
      if (bulletPending) output += "- ";
      bulletPending = false;
      output += text;
      hasText = true;
      continue;
    }

    const { kind, name } = token;
    if (name === "li") {
      setItemOpen(kind === "open");
      bulletPending = kind === "open";
      if (kind === "open") requestBreak(1);
    } else if (LIST.has(name)) {
      if (kind === "open") lists.push(false);
      else if (lists.pop() === true) openItems -= 1;
      requestBreak(inListItem() ? 1 : 2);
    } else if (name === "br") {
      pendingBreak = pendingBreak === 0 ? 1 : 2;
    } else if (BLOCK.has(name)) {
      // A paragraph that wraps a list item's text is part of the item, not a new block.
      if (bulletPending && kind === "open" && WRAPPER.has(name)) continue;
      requestBreak(inListItem() ? 1 : 2);
    } else if (CELL.has(name) && kind === "open") {
      output += " ";
    }
  }

  return output
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .normalize("NFC");
}

/**
 * Splits HTML into text and tag tokens in one pass, following the HTML tokenizer where it
 * matters for text: comments, doctypes, and processing instructions are dropped; quoted
 * attribute values may contain `>`; a `<` that cannot start a tag is text; and a tag cut off by
 * the end of the input is dropped. Attributes are not kept.
 */
function* tokenizeHtml(html: string): Generator<HtmlToken> {
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      yield { kind: "text", text: html.slice(index) };
      return;
    }
    if (open > index) yield { kind: "text", text: html.slice(index, open) };

    const next = html.charAt(open + 1);
    if (html.startsWith("<!--", open)) {
      index = afterMarker(html, "-->", open + 4);
      continue;
    }
    if (next === "!" || next === "?") {
      index = afterMarker(html, ">", open + 2);
      continue;
    }
    const closing = next === "/";
    const nameStart = closing ? open + 2 : open + 1;
    if (!isAsciiLetter(html.charAt(nameStart))) {
      if (closing) {
        // `</>` is dropped and `</ x>` is a bogus comment in the HTML tokenizer.
        index = afterMarker(html, ">", nameStart);
      } else {
        yield { kind: "text", text: "<" };
        index = open + 1;
      }
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < html.length && !isTagNameEnd(html.charAt(nameEnd))) nameEnd += 1;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = findTagEnd(html, nameEnd);
    if (end < 0) return;
    index = end + 1;
    yield { kind: closing ? "close" : "open", name };

    const skipped = closing ? undefined : SKIPPED.get(name);
    if (skipped !== undefined && html.charAt(end - 1) !== "/") {
      skipped.lastIndex = index;
      const match = skipped.exec(html);
      index = match === null ? html.length : match.index;
    }
  }
}

/** Index of the `>` that ends a tag whose name ends at `from`, or -1 at the end of input. */
function findTagEnd(html: string, from: number): number {
  let index = from;
  while (index < html.length) {
    const char = html.charAt(index);
    if (char === ">") return index;
    index += 1;
    if (char !== "=") continue;
    while (isHtmlSpace(html.charAt(index))) index += 1;
    const quote = html.charAt(index);
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, index + 1);
      if (close < 0) return -1;
      index = close + 1;
    }
  }
  return -1;
}

function afterMarker(html: string, marker: string, from: number): number {
  const at = html.indexOf(marker, from);
  return at < 0 ? html.length : at + marker.length;
}

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

function isHtmlSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r";
}

function isTagNameEnd(char: string): boolean {
  return char === "/" || char === ">" || isHtmlSpace(char);
}
