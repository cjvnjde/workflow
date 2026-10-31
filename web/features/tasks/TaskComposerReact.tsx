import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowUp,
  Code2,
  FileText,
  Image,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { Attachment } from "../../../src/contracts/index.js";
import { Button } from "../../components/ui/button.js";
import { Textarea } from "../../components/ui/textarea.js";
import { apiUrl, request } from "../../shared/api.js";
import { attachmentSchema } from "../../../src/contracts/index.js";

type TaskComposerProps = {
  text: string;
  files: Attachment[];
  automatic: boolean;
  onTextChange: (value: string) => void;
  onFilesChange: (value: Attachment[]) => void;
  onSubmit: (prompt: string, attachments: string[]) => Promise<void>;
  onSettings: () => void;
  onDiscard: () => void;
};

const suggestions = [
  { prompt: "Find and fix a bug in this project", icon: Code2 },
  { prompt: "Build a feature from my screenshots", icon: Image },
  { prompt: "Review this code and suggest improvements", icon: Search },
];

function useAutosize(elementRef: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    let frame = 0;
    let width = -1;
    let disposed = false;
    const fit = () => {
      frame = 0;
      if (disposed || !element.getClientRects().length) return;
      const style = getComputedStyle(element);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const maximum = Math.max(
        line + padding + border,
        Math.min(
          16 * line + padding + border,
          window.innerHeight * 0.5,
          parseFloat(style.maxHeight) || Infinity,
        ),
      );
      const minimum = Math.min(
        maximum,
        Math.max(
          Math.max(2, element.rows) * line + padding + border,
          parseFloat(style.minHeight) || 0,
        ),
      );
      element.style.height = "0px";
      const content = element.scrollHeight + border;
      element.style.height = `${Math.ceil(Math.max(minimum, Math.min(maximum, content)))}px`;
      element.style.overflowY = content > maximum + 1 ? "auto" : "hidden";
    };
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(fit);
    };
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        schedule();
      }
    });
    observer.observe(element);
    element.addEventListener("input", schedule);
    window.addEventListener("resize", schedule);
    schedule();
    void document.fonts.ready.then(schedule);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("input", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [elementRef, value]);
}

function readFile(file: File, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.onloadend = () => signal.removeEventListener("abort", abort);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function TaskComposerReact({
  text,
  files,
  automatic,
  onTextChange,
  onFilesChange,
  onSubmit,
  onSettings,
  onDiscard,
}: TaskComposerProps) {
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const uploadController = useRef<AbortController | undefined>(undefined);
  const filesRef = useRef(files);
  const textRef = useRef(text);
  filesRef.current = files;
  textRef.current = text;
  useAutosize(input, text);

  useEffect(
    () => () => {
      uploadController.current?.abort();
    },
    [],
  );

  async function attach(selected: File[]) {
    if (uploading || submitting || !selected.length) return;
    if (selected.length + filesRef.current.length > 8) {
      setError("Attach up to eight files per task.");
      return;
    }
    setUploading(true);
    const controller = new AbortController();
    uploadController.current = controller;
    setError("");
    try {
      for (const file of selected) {
        controller.signal.throwIfAborted();
        if (file.size > 6_000_000) throw new Error(`${file.name} exceeds 6 MB.`);
        const data = await readFile(file, controller.signal);
        controller.signal.throwIfAborted();
        const attached = await request("/api/attachments", attachmentSchema, {
          method: "POST",
          body: {
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            data,
          },
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        const next = [...filesRef.current, attached];
        filesRef.current = next;
        onFilesChange(next);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setUploading(false);
      if (uploadController.current === controller) uploadController.current = undefined;
      if (picker.current) picker.current.value = "";
    }
  }

  async function submit() {
    if (!textRef.current.trim() || uploading || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(
        textRef.current.trim(),
        filesRef.current.map((file) => file.id),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setSubmitting(false);
    }
  }

  function keydown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function paste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData.files);
    if (!pasted.length) return;
    event.preventDefault();
    void attach(pasted);
  }

  return (
    <div className="shadcn-theme dark space-y-3 text-left text-foreground">
      <div
        className={`relative overflow-hidden rounded-xl border bg-card shadow-sm transition-colors ${dragging ? "border-ring ring-2 ring-ring/30" : "border-border"}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void attach(Array.from(event.dataTransfer.files));
        }}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-4">
            {files.map((file) => (
              <div
                key={file.id}
                className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted px-2 py-1.5 text-xs"
              >
                {file.kind === "image" ? (
                  <img
                    className="size-8 rounded object-cover"
                    src={apiUrl(`/api/attachments/${file.id}`)}
                    alt={file.name}
                  />
                ) : (
                  <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="min-w-0 truncate">
                  {file.name}
                  <small className="ml-2 text-muted-foreground">
                    {Math.ceil(file.size / 1000)} KB
                  </small>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Remove ${file.name}`}
                  disabled={submitting}
                  onClick={() => {
                    const next = filesRef.current.filter((item) => item.id !== file.id);
                    filesRef.current = next;
                    onFilesChange(next);
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <Textarea
          ref={input}
          value={text}
          aria-label="What should we work on?"
          placeholder="Describe what you want to build, fix, or explore…"
          maxLength={32_000}
          rows={4}
          disabled={submitting}
          className="max-h-[50vh] min-h-32 resize-none rounded-none border-0 bg-transparent px-5 pt-5 pb-2 text-sm shadow-none focus-visible:ring-0"
          onChange={(event) => onTextChange(event.currentTarget.value)}
          onKeyDown={keydown}
          onPaste={paste}
        />
        <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-3 sm:px-4">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Attach files"
            onChange={(event) => void attach(Array.from(event.currentTarget.files ?? []))}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={uploading || submitting}
            onClick={() => picker.current?.click()}
          >
            <Plus aria-hidden="true" />
            {uploading ? "Attaching…" : "Attach files"}
          </Button>
          <span className="hidden flex-1 text-xs text-muted-foreground md:block">
            Paste screenshots · Shift + Enter for a new line
          </span>
          {uploading && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => uploadController.current?.abort()}
            >
              Cancel upload
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            className="ml-auto"
            aria-label="Start task"
            title="Start task"
            disabled={!text.trim() || uploading || submitting}
            onClick={() => void submit()}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 grid place-content-center gap-2 bg-background/95 text-center text-sm font-medium text-foreground">
            <Image className="mx-auto size-7" aria-hidden="true" />
            Drop files to add context
          </div>
        )}
      </div>
      {error && (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {automatic ? (
            <Sparkles className="size-3.5" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-3.5" aria-hidden="true" />
          )}
          {automatic ? "Automatic execution enabled" : "You review the workflow before it runs"}
        </span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-1 py-0 text-xs"
          onClick={onSettings}
        >
          Change in Settings
        </Button>
        {(text || files.length > 0) && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-1 py-0 text-xs text-muted-foreground"
            disabled={uploading || submitting}
            onClick={() => {
              setError("");
              onDiscard();
            }}
          >
            Discard task draft
          </Button>
        )}
      </div>
      {!text && !files.length && (
        <div className="grid gap-2 sm:grid-cols-3">
          {suggestions.map(({ prompt, icon: Icon }) => (
            <Button
              key={prompt}
              type="button"
              variant="outline"
              className="h-auto min-h-14 justify-start whitespace-normal px-3 py-3 text-left text-xs leading-relaxed"
              onClick={() => {
                onTextChange(prompt);
                input.current?.focus();
              }}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{prompt}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
