import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-text.ts";

const EM_DASH = String.fromCodePoint(0x2014);

describe("htmlToText", () => {
  it("turns block elements into paragraphs", () => {
    expect(htmlToText("<h2>About us</h2><p>We build things.</p><div>Join us.</div>")).toBe(
      "About us\n\nWe build things.\n\nJoin us.",
    );
  });

  it("turns list items into dash lines without blank lines between items", () => {
    expect(htmlToText("<p>You have:</p><ul><li>TypeScript</li><li>SQL</li></ul><p>Bonus</p>")).toBe(
      "You have:\n\n- TypeScript\n- SQL\n\nBonus",
    );
  });

  it("keeps a paragraph inside a list item on the item's line", () => {
    expect(htmlToText("<ul><li><p>First</p></li><li><div><p>Second</p></div></li></ul>")).toBe(
      "- First\n- Second",
    );
  });

  it("drops empty list items", () => {
    expect(htmlToText("<ul><li></li><li>Only</li><li> </li></ul>")).toBe("- Only");
  });

  it("turns <br> into a line break and collapses source whitespace", () => {
    expect(htmlToText("<p>Line one<br/>Line   two\n  continues</p>")).toBe(
      "Line one\nLine two continues",
    );
  });

  it("decodes named, decimal, and hex entities after removing tags", () => {
    expect(htmlToText("<p>Caf&eacute; &amp; bar &#8211; &#x2014; &mdash; &lt;b&gt;</p>")).toBe(
      `Café & bar ${String.fromCodePoint(0x2013)} ${EM_DASH} ${EM_DASH} <b>`,
    );
  });

  it("treats non-breaking and other Unicode spaces as ordinary spaces", () => {
    const emSpace = String.fromCodePoint(0x2003);
    expect(htmlToText(`<p>a&nbsp;&nbsp;b${emSpace}c</p>`)).toBe("a b c");
  });

  it("removes comments, scripts, styles, and templates with their contents", () => {
    expect(
      htmlToText(
        "<!-- note --><style>p{}</style><p>Keep</p><script>alert(1)</script><template><p>x</p></template>",
      ),
    ).toBe("Keep");
  });

  it("keeps attributes out of the text", () => {
    expect(htmlToText('<p style="color: red" data-x="<b>">Styled</p>')).toBe("Styled");
  });

  it("normalizes to NFC", () => {
    const decomposed = `Cafe${String.fromCodePoint(0x301)}`;
    expect(htmlToText(`<p>${decomposed}</p>`)).toBe(`Caf${String.fromCodePoint(0xe9)}`);
  });

  it("returns an empty string for markup without text", () => {
    expect(htmlToText("<div><p> </p><br></div>")).toBe("");
  });

  it("flattens nested lists and closes list items implicitly", () => {
    expect(htmlToText("<ul><li>Parent<ul><li>Child</li></ul></li><li>Next</ul><p>After</p>")).toBe(
      "- Parent\n- Child\n- Next\n\nAfter",
    );
    expect(htmlToText("<li>Orphan item<li>Another")).toBe("- Orphan item\n- Another");
  });

  it("turns two line breaks into a blank line and separates table cells", () => {
    expect(htmlToText("One<br><br>Two")).toBe("One\n\nTwo");
    expect(htmlToText("<table><tr><td>Level</td><td>Salary</td></tr></table>")).toBe(
      "Level Salary",
    );
  });

  it("follows the HTML tokenizer on malformed markup", () => {
    expect(htmlToText("a < b and <3 and </>c")).toBe("a < b and <3 and c");
    expect(htmlToText("<P CLASS=x>Upper</P><p data-a=1>Unquoted</p>")).toBe("Upper\n\nUnquoted");
    expect(htmlToText("<!DOCTYPE html><?xml x?><p>Body</p></ bogus>")).toBe("Body");
    expect(htmlToText("Kept <p class='cut")).toBe("Kept");
    expect(htmlToText("Kept <!-- never closed")).toBe("Kept");
    expect(htmlToText("Kept <script>never closed")).toBe("Kept");
  });

  it("runs in linear time on adversarial markup", () => {
    const start = performance.now();
    for (const unit of [
      '<a "',
      '<p x="',
      "<li",
      "<style",
      "<!--",
      "</p></p>",
      "<ul><li>",
      "a<b>",
    ]) {
      htmlToText(unit.repeat(Math.ceil(200_000 / unit.length)));
    }
    // About 50 ms in total on a laptop; a quadratic regression takes minutes.
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  test.prop([fc.string({ maxLength: 200 })])(
    "never pads lines or leaves blank line runs",
    (html) => {
      const text = htmlToText(html);
      expect(text).not.toMatch(/\n{3,}/);
      for (const line of text.split("\n")) expect(line).toBe(line.trim());
      expect(text).toBe(text.normalize("NFC"));
    },
  );
});
