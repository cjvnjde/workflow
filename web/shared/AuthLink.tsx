import type { ReactNode } from "react";

export default function AuthLink({ url, children }: { url: string; children?: ReactNode }) {
  // Provider messages must never become executable URLs.
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}
