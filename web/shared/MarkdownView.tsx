import { useMemo, type ReactNode } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true });
// Model output must not execute HTML or silently load remote tracking images.
parser.renderer.rules.image = (tokens, index) =>
  `<span class="markdown-image">[Image: ${parser.utils.escapeHtml(tokens[index]?.content ?? "")}]</span>`;

export default function MarkdownView({
  content,
  children,
}: {
  content: string;
  children?: ReactNode;
}) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(parser.render(content), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["img", "style", "input", "form", "iframe"],
      }),
    [content],
  );
  return (
    <>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      {children}
    </>
  );
}
