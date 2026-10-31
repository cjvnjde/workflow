import { useEffect, useMemo, useRef, useState } from "react";
import type { EvidenceIdentity, StoredEvidenceValue } from "../../src/contracts/index.js";
import { client } from "./api.js";
import Icon from "./Icon.js";
import "./EvidenceValue.css";

export interface EvidenceValueProps {
  identity: EvidenceIdentity;
  value: StoredEvidenceValue;
  label: string;
  named?: boolean;
}

export default function EvidenceValue(props: EvidenceValueProps) {
  const [opened, setOpened] = useState(false);
  const { identity, value, label } = props;
  const contentKey = `${identity.runId}/${identity.nodeId}/${identity.visit}/${value.state === "captured" ? value.ref.id : value.state}`;
  return (
    <details className="evidence-value" onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>
        <strong>{label}</strong>
        <span>
          {value.state === "captured"
            ? `Exact stored value · ${value.ref.bytes.toLocaleString()} bytes`
            : value.state === "undefined"
              ? "No value (undefined)"
              : "Unavailable"}
        </span>
      </summary>
      {value.state === "undefined" ? (
        <p className="evidence-empty">
          This invocation did not supply a value. It is distinct from null or an empty object.
        </p>
      ) : value.state === "unavailable" ? (
        <p className="evidence-unavailable">{value.reason}</p>
      ) : (
        <CapturedEvidence key={contentKey} {...props} value={value} opened={opened} />
      )}
    </details>
  );
}

interface LoadedEvidence {
  attempt: number;
  text?: string;
  error?: string;
}

function CapturedEvidence({
  identity,
  value,
  label,
  named,
  opened,
}: EvidenceValueProps & {
  value: Extract<StoredEvidenceValue, { state: "captured" }>;
  opened: boolean;
}) {
  const [loaded, setLoaded] = useState<LoadedEvidence>();
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const mounted = useRef(false);
  const content = value.ref;
  const { runId, nodeId, visit } = identity;
  const isImage = content.mediaType.startsWith("image/");
  const url = client.evidenceContentUrl(runId, nodeId, visit, content.id);
  const downloadUrl = client.evidenceContentUrl(runId, nodeId, visit, content.id, true);
  const current = loaded?.attempt === attempt ? loaded : undefined;
  const text = current?.text;
  const error = current?.error ?? "";
  const loading = opened && !isImage && current === undefined;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!opened || isImage || current !== undefined) return;
    const controller = new AbortController();
    void client.evidenceContent(runId, nodeId, visit, content.id, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setLoaded({ attempt, text: result });
      },
      (failure: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            attempt,
            error: failure instanceof Error ? failure.message : String(failure),
          });
      },
    );
    return () => controller.abort();
  }, [opened, isImage, runId, nodeId, visit, content.id, attempt, current]);

  const parsed = useMemo(() => {
    if (!content.mediaType.includes("json") || text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }, [content.mediaType, text]);
  const displayed = useMemo(
    () => (parsed !== undefined ? JSON.stringify(parsed, null, 2) : (text ?? "")),
    [parsed, text],
  );
  const fields = useMemo(
    () =>
      named && parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.entries(parsed as Record<string, unknown>)
        : undefined,
    [named, parsed],
  );
  const matches = useMemo(() => {
    if (!query) return [];
    const source = displayed.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const found: number[] = [];
    for (
      let offset = source.indexOf(needle);
      offset !== -1 && found.length < 10000;
      offset = source.indexOf(needle, offset + Math.max(1, needle.length))
    )
      found.push(offset);
    return found;
  }, [displayed, query]);
  const windowStart =
    query && matches.length ? Math.max(0, (matches[matchIndex] ?? matches[0]!) - 400) : 0;
  const preview = displayed.slice(windowStart, windowStart + 24000);
  const pieces = useMemo(() => {
    if (!query) return [{ text: preview, match: false, key: preview }];
    const result: { text: string; match: boolean; key: string }[] = [];
    const occurrences = new Map<string, number>();
    function append(text: string, match: boolean) {
      const identity = JSON.stringify([match, text]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      result.push({ text, match, key: `${occurrence}:${identity}` });
    }
    const lower = preview.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let start = 0;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, start)) {
      append(preview.slice(start, at), false);
      append(preview.slice(at, at + needle.length), true);
      start = at + needle.length;
    }
    append(preview.slice(start), false);
    return result;
  }, [preview, query]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        isImage ? new URL(url, location.href).href : (text ?? ""),
      );
      if (mounted.current) setNotice(isImage ? "Image link copied" : "Full stored value copied");
    } catch {
      if (mounted.current) setNotice("Clipboard unavailable. Download the stored value instead.");
    }
  }
  function move(direction: number) {
    if (matches.length)
      setMatchIndex((index) => (index + direction + matches.length) % matches.length);
  }
  return (
    <>
      {loading && <p role="status">Loading the stored value…</p>}
      {error && (
        <div className="evidence-unavailable" role="status">
          {error}{" "}
          <button
            type="button"
            className="quiet"
            onClick={() => setAttempt((previous) => previous + 1)}
          >
            Retry loading
          </button>
        </div>
      )}
      {(text !== undefined || isImage) && (
        <>
          <div className="evidence-actions">
            <button
              type="button"
              className="quiet"
              aria-label={`Copy ${label}`}
              onClick={() => void copy()}
            >
              <Icon name="copy" size={13} />
              {isImage ? "Copy image link" : "Copy full value"}
            </button>
            <a href={downloadUrl} download>
              <Icon name="download" size={13} />
              Download
            </a>
            {notice && <span role="status">{notice}</span>}
          </div>
          {isImage ? (
            opened && <img src={url} alt={label} className="evidence-image" />
          ) : (
            <>
              <div className="evidence-search">
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setMatchIndex(0);
                  }}
                  type="search"
                  aria-label={`Search ${label}`}
                  placeholder="Search the full stored value…"
                />
                {query && (
                  <>
                    <span>
                      {matches.length
                        ? `${matchIndex + 1} of ${matches.length}${matches.length === 10000 ? "+" : ""}`
                        : "No matches"}
                    </span>
                    <button
                      type="button"
                      className="quiet"
                      disabled={!matches.length}
                      aria-label={`Previous match in ${label}`}
                      onClick={() => move(-1)}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      disabled={!matches.length}
                      aria-label={`Next match in ${label}`}
                      onClick={() => move(1)}
                    >
                      Next
                    </button>
                  </>
                )}
              </div>
              {fields && fields.length > 50 && !query && (
                <p className="evidence-preview-note">
                  Showing the first 50 named fields of {fields.length}. Search, copy and download
                  include every field.
                </p>
              )}
              {fields?.length && !query ? (
                <div className="evidence-fields">
                  {fields.slice(0, 50).map(([name, fieldValue]) => {
                    const fieldText = JSON.stringify(fieldValue, null, 2) ?? "undefined";
                    const type =
                      fieldValue === null
                        ? "null"
                        : Array.isArray(fieldValue)
                          ? "array"
                          : typeof fieldValue;
                    return (
                      <section key={name}>
                        <h4>
                          {name}
                          <small>{type}</small>
                        </h4>
                        <pre>{fieldText.slice(0, 6000)}</pre>
                        {fieldText.length > 6000 && (
                          <p>
                            Field preview shortened. Search, copy or download to inspect the full
                            fieldValue.
                          </p>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <>
                  {displayed.length > preview.length && (
                    <p className="evidence-preview-note">
                      Preview: characters {windowStart + 1}–{windowStart + preview.length} of{" "}
                      {displayed.length.toLocaleString()}. Search, copy and download use the full
                      stored value.
                    </p>
                  )}
                  <pre className="evidence-text">
                    {pieces.map((piece) =>
                      piece.match ? <mark key={piece.key}>{piece.text}</mark> : piece.text,
                    )}
                  </pre>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
