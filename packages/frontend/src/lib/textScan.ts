// Linear string helpers for note text (the wikilink and hashtag scanners are
// @onden/markdown's text grammar). Every body parser stays linear:
// test/bodyParsersLinear.test.ts times them on pathological bodies.

/** `text` without the trailing characters in `chars` (what /[…]+$/ removes,
 *  without its quadratic rescans of a long run that does not reach the end). */
export function stripTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Each line's leading and trailing spaces removed, in one pass (what the
 *  regex "space-star newline space-star" did between lines, without its
 *  quadratic rescans of long space runs). */
export function trimLineSpaces(text: string): string {
  return text.split("\n").map((line) => {
    let a = 0, b = line.length;
    while (a < b && line[a] === " ") a++;
    while (b > a && line[b - 1] === " ") b--;
    return line.slice(a, b);
  }).join("\n");
}
