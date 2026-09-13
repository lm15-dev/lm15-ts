/** Lightweight visual coloring only. Source text stays exact; nothing is parsed as HTML. */
export type Token = { text: string; kind?: "string" | "comment" | "keyword" | "number" };
export function tokens(source: string, language: string): Token[] {
  const comments = language === "python" || language === "curl" ? "#[^\\n]*" : "//[^\\n]*|/\\*[\\s\\S]*?\\*/";
  const pattern = new RegExp(`("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\x60(?:\\\\.|[^\x60\\\\])*\x60)|(${comments})|\\b(const|let|var|import|from|as|new|await|async|for|of|in|if|else|return|fn|use|pub|mut|true|false|null|None|True|False|Some|Ok|with|class|def|try|except|while|yield)\\b|\\b(\\d+(?:\\.\\d+)?)\\b`, "g");
  const out: Token[] = [];
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset) out.push({ text: source.slice(offset, match.index) });
    out.push({ text: match[0], kind: match[1] ? "string" : match[2] ? "comment" : match[3] ? "keyword" : "number" });
    offset = match.index + match[0].length;
  }
  if (offset < source.length) out.push({ text: source.slice(offset) });
  return out;
}

export function renderCode(element: HTMLElement, source: string, language: string): void {
  const fragment = document.createDocumentFragment();
  const lines = source.split("\n");
  let marked = false;
  for (const [index, text] of lines.entries()) {
    const line = document.createElement("span");
    line.className = "code-line";
    line.dataset.line = String(index + 1);
    if (!marked && (/\b(?:const |let )?request\s*=|^\{$|^curl /.test(text))) { line.dataset.request = "true"; marked = true; }
    for (const token of tokens(text, language)) {
      if (!token.kind) line.append(document.createTextNode(token.text));
      else {
        const span = document.createElement("span");
        span.className = `token-${token.kind}`;
        span.textContent = token.text;
        line.append(span);
      }
    }
    if (index < lines.length - 1) line.append(document.createTextNode("\n"));
    fragment.append(line);
  }
  element.replaceChildren(fragment);
}
