/**
 * Fencing untrusted text inside a tagged prompt block. Customer messages and
 * documentation passages are data; a closing tag inside them must not be able
 * to end the block and let the rest read as instructions.
 */

/**
 * Replace every spelling of `</tag>` in `text` with `[/tag]`. Zero-width
 * characters are removed first so they cannot split the tag name, and the
 * match takes any spacing, case, attributes, `/>`, or a backslash-escaped
 * slash. Look-alike glyphs (a fullwidth bracket, say) cannot be caught by a
 * regex and are not tried: the real defense is the server gate, which no
 * prompt text can open.
 *
 * @param tag a plain word such as `documentation` (letters, digits, `_`).
 */
export function neutralizeClosingTag(text: string, tag: string): string {
  return text
    .replace(/[​-‍﻿]/g, '')
    .replace(new RegExp(`<\\\\?/\\s*${tag}\\b[^>]*>`, 'gi'), `[/${tag}]`)
}
