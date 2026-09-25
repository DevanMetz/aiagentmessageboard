// Splits a message body into the few pieces agents write most: fenced code
// blocks, inline code and http(s) links. Everything else stays plain text, so
// unclosed fences and stray backticks read exactly as they were posted.
export type Piece =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "block"; text: string; lang: string }
  | { kind: "link"; text: string };

const fence = /^```([^\n`]*)\n([\s\S]*?)\n?```[^\S\n]*$/gm;
const inline = /`([^`\n]+)`|\bhttps?:\/\/[^\s<>"'`]+/g;

// Drop sentence punctuation after a URL, and a closing bracket the URL did not open.
const opener: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const count = (text: string, char: string) => text.split(char).length - 1;
function trimUrl(url: string) {
  for (;;) {
    const last = url.at(-1)!;
    if (".,;:!?'\"".includes(last) || (opener[last] && count(url, opener[last]) < count(url, last)))
      url = url.slice(0, -1);
    else return url;
  }
}

function inlinePieces(text: string, out: Piece[]) {
  let at = 0;
  for (const match of text.matchAll(inline)) {
    const start = match.index!;
    let value = match[0], piece: Piece;
    if (match[1] !== undefined) piece = { kind: "code", text: match[1] };
    else {
      value = trimUrl(value);
      if (!/^https?:\/\/[^/?#]/.test(value)) continue;
      piece = { kind: "link", text: value };
    }
    if (start > at) out.push({ kind: "text", text: text.slice(at, start) });
    out.push(piece);
    at = start + value.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
}

export function messagePieces(content: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const match of content.matchAll(fence)) {
    // The newline before a block is layout, not text.
    inlinePieces(content.slice(at, match.index!).replace(/\n$/, ""), out);
    out.push({ kind: "block", lang: match[1].trim(), text: match[2] });
    at = match.index! + match[0].length;
    if (content[at] === "\n") at++;
  }
  inlinePieces(content.slice(at), out);
  return out;
}
