const PLACEHOLDER_TITLE =
  /^\W*(?:(?:external|internal)\s+)?(?:template|test (?:job|posting))\s*[-:|\]]|\bdo not apply\b/i;
const PLACEHOLDER_LOCATION = /\btemplates?\b|\bz-?test\b/i;

/**
 * Whether a posting is a template or test that an employer published by mistake, which nobody
 * can apply to. Such postings say so in their title or location labels: "EXTERNAL TEMPLATE -
 * Hybrid adverts", or a location named "z-Test & Templates Only".
 *
 * The rule is narrow on purpose, since real jobs can be about tests and templates ("Test
 * Engineer", "Template Technician") and real places can sound like them (Test Valley, in
 * Hampshire). A title counts only when it opens with a template or test marker set off by
 * punctuation, or says not to apply; a location label only when it names templates or a
 * "z-test" bucket.
 */
export function isPlaceholder(posting: {
  readonly title: string;
  readonly locations: readonly string[];
}): boolean {
  return (
    PLACEHOLDER_TITLE.test(posting.title) ||
    posting.locations.some((label) => PLACEHOLDER_LOCATION.test(label))
  );
}
