import { useEffect, useRef, useState, type ReactNode } from "react";
import Icon from "./Icon.js";

export default function MarkdownActions({
  content,
  filename,
  children,
}: {
  content: string;
  filename?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const pendingDownloads = downloads.current;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      for (const [url, timeout] of pendingDownloads) {
        clearTimeout(timeout);
        URL.revokeObjectURL(url);
      }
      pendingDownloads.clear();
    };
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      if (!mounted.current) return;
      setError("");
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (mounted.current) setError("Clipboard unavailable. Download the Markdown instead.");
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = (filename ?? "result.md").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 180);
    link.click();
    downloads.current.set(
      url,
      setTimeout(() => {
        URL.revokeObjectURL(url);
        downloads.current.delete(url);
      }, 1000),
    );
  }
  return (
    <div className="markdown-actions">
      <button
        type="button"
        className="quiet"
        aria-label="Copy Markdown"
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
        {copied ? "Copied" : "Copy Markdown"}
      </button>
      <button type="button" className="quiet" aria-label="Download Markdown" onClick={download}>
        <Icon name="download" size={14} />
        Download
      </button>
      {copied && (
        <small className="sr-only" role="status">
          Markdown copied
        </small>
      )}
      {error && <small role="alert">{error}</small>}
      {children}
    </div>
  );
}
