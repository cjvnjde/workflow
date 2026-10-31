import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  designScopes,
  designSessionSchema,
  type DesignScope,
  type DesignSession,
  type DesignPageContext,
} from "../../../src/contracts/index.js";
import type { DesignRequest } from "./design-types.js";
import { request } from "../../shared/api.js";
import Icon from "../../shared/Icon.js";
import DesignChatWindow from "./DesignChatWindow.js";
import {
  defaultChatSize,
  fitWindow,
  type WindowSize,
  type WindowPoint,
} from "./floating-window.js";

type Props = {
  pageContext: DesignPageContext;
  requested?: DesignRequest;
  hasUnsavedSettings: boolean;
  onApplied: () => Promise<void>;
  onApplyingChange?: (value: boolean) => void;
  onChatsChange?: (count: number) => void;
};
type Chat = {
  session: DesignSession;
  draft: string;
  minimized: boolean;
  position: WindowPoint;
  size: WindowSize;
  layer: number;
};
const storageKey = "workflow:design-windows:v2";

function bounds(size: WindowSize, point: WindowPoint) {
  return fitWindow(size, point, { width: window.innerWidth, height: window.innerHeight });
}

function persist(chats: Chat[]) {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(
        chats.map(({ session, draft, minimized, position, size }) => ({
          id: session.id,
          draft,
          minimized,
          position,
          size,
        })),
      ),
    );
  } catch {
    /* Optional local window layout. */
  }
}

const savedWindowSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  draft: z.string().catch(""),
  minimized: z.coerce.boolean(),
  position: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .optional()
    .catch(undefined),
  size: z
    .object({ width: z.number().finite(), height: z.number().finite() })
    .optional()
    .catch(undefined),
});

export default function DesignDock({
  pageContext,
  requested,
  hasUnsavedSettings,
  onApplied,
  onApplyingChange,
  onChatsChange,
}: Props) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(0);
  const [applying, setApplying] = useState<ReadonlySet<string>>(() => new Set());
  const chatsRef = useRef<Chat[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const pending = useRef(new Map<DesignScope, Promise<void>>());
  const applyingRef = useRef<ReadonlySet<string>>(applying);
  const layer = useRef(40);

  const updateChats = useCallback((update: (current: Chat[]) => Chat[], saveLayout = true) => {
    const next = update(chatsRef.current);
    chatsRef.current = next;
    setChats(next);
    if (saveLayout) persist(next);
  }, []);

  const add = useCallback(
    (session: DesignSession, draft = "", saved?: Partial<Chat>) => {
      if (!controllerRef.current || controllerRef.current.signal.aborted) return;
      updateChats((current) => {
        const existing = current.find((chat) => chat.session.id === session.id);
        if (existing) {
          // A late restoration must not replace a draft the user is already editing.
          if (saved) return current;
          const nextLayer = ++layer.current;
          return current.map((chat) =>
            chat === existing
              ? { ...chat, minimized: false, layer: nextLayer, draft: draft || chat.draft }
              : chat,
          );
        }
        const offset = (current.length % 3) * 48;
        return [
          ...current,
          {
            session,
            draft,
            minimized: saved?.minimized ?? false,
            layer: ++layer.current,
            ...bounds(
              saved?.size ?? defaultChatSize,
              saved?.position ?? {
                x: window.innerWidth - 464 - offset,
                y: window.innerHeight - 764 + offset,
              },
            ),
          },
        ];
      });
    },
    [updateChats],
  );

  const show = useCallback(
    (id: string, prompt?: string) => {
      const nextLayer = ++layer.current;
      updateChats((current) =>
        current.map((chat) =>
          chat.session.id === id
            ? { ...chat, minimized: false, layer: nextLayer, draft: prompt || chat.draft }
            : chat,
        ),
      );
    },
    [updateChats],
  );

  const open = useCallback(
    async (scope: DesignScope, fresh = false, prompt?: string) => {
      const signal = controllerRef.current?.signal;
      if (!signal || signal.aborted) return;
      if (!fresh) {
        const existing = chatsRef.current.findLast((chat) => chat.session.scope === scope);
        if (existing) {
          show(existing.session.id, prompt);
          return;
        }
        const pendingJob = pending.current.get(scope);
        if (pendingJob) {
          await pendingJob;
          if (signal.aborted || !prompt) return;
          const found = chatsRef.current.findLast((chat) => chat.session.scope === scope);
          if (found) {
            updateChats((current) =>
              current.map((chat) => (chat === found ? { ...chat, draft: prompt } : chat)),
            );
          }
          return;
        }
      }
      const job = (async () => {
        setOpening((count) => count + 1);
        setError("");
        try {
          const latest = fresh
            ? null
            : await request(`/api/design/${scope}/latest`, designSessionSchema.nullable(), {
                signal,
              });
          const session =
            latest ??
            (await request("/api/design", designSessionSchema, {
              method: "POST",
              body: { scope },
              signal,
            }));
          if (!signal.aborted) add(session, prompt);
        } catch (failure) {
          if (!signal.aborted)
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          if (!signal.aborted) setOpening((count) => count - 1);
        }
      })();
      if (!fresh) pending.current.set(scope, job);
      await job;
      if (pending.current.get(scope) === job) pending.current.delete(scope);
    },
    [add, show, updateChats],
  );

  useEffect(() => {
    const controller = new AbortController();
    const pendingJobs = pending.current;
    controllerRef.current = controller;
    const resize = () =>
      updateChats((current) =>
        current.map((chat) => ({
          ...chat,
          ...bounds(chat.size, chat.position),
        })),
      );
    window.addEventListener("resize", resize);
    let saved: unknown;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    } catch {
      saved = [];
    }
    async function restore() {
      if (!Array.isArray(saved)) return;
      for (const raw of saved) {
        if (controller.signal.aborted) break;
        const parsed = savedWindowSchema.safeParse(raw);
        if (!parsed.success) continue;
        const item = parsed.data;
        try {
          const session = await request(`/api/design/${item.id}`, designSessionSchema, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) break;
          add(session, item.draft.slice(0, 8000), {
            minimized: item.minimized,
            position: item.position,
            size: item.size,
          });
        } catch {
          /* Closed servers or deleted sessions must not block the workspace. */
        }
      }
    }
    void restore();
    return () => {
      controller.abort();
      pendingJobs.clear();
      window.removeEventListener("resize", resize);
    };
  }, [add, updateChats]);

  useEffect(() => {
    if (!requested) return;
    let canceled = false;
    void Promise.resolve().then(() => {
      if (!canceled) void open(requested.scope, false, requested.prompt);
    });
    return () => {
      canceled = true;
    };
  }, [requested, open]);

  useEffect(() => {
    onChatsChange?.(chats.length);
  }, [chats.length, onChatsChange]);

  const updateSession = useCallback(
    (session: DesignSession) => {
      updateChats(
        (current) =>
          current.map((chat) => (chat.session.id === session.id ? { ...chat, session } : chat)),
        false,
      );
    },
    [updateChats],
  );

  function focus(id: string) {
    const nextLayer = ++layer.current;
    updateChats(
      (current) =>
        current.map((chat) => (chat.session.id === id ? { ...chat, layer: nextLayer } : chat)),
      false,
    );
  }

  function minimize(id: string) {
    updateChats((current) =>
      current.map((chat) =>
        chat.session.id === id
          ? {
              ...chat,
              minimized: !chat.minimized,
              layer: chat.minimized ? ++layer.current : chat.layer,
            }
          : chat,
      ),
    );
  }

  function close(id: string) {
    if (applyingRef.current.has(id)) return;
    updateChats((current) => current.filter((chat) => chat.session.id !== id));
  }

  function applyingChange(id: string, value: boolean) {
    const next = new Set(applyingRef.current);
    if (value) next.add(id);
    else next.delete(id);
    applyingRef.current = next;
    setApplying(next);
    onApplyingChange?.(next.size > 0);
  }

  let focusedId: string | undefined;
  let topLayer = -Infinity;
  for (const chat of chats) {
    if (!chat.minimized && chat.layer > topLayer) {
      topLayer = chat.layer;
      focusedId = chat.session.id;
    }
  }

  return (
    <div className="design-dock">
      {chats.map((chat) => (
        <DesignChatWindow
          key={chat.session.id}
          initial={chat.session}
          pageContext={pageContext}
          draft={chat.draft}
          position={chat.position}
          size={chat.size}
          layer={chat.layer}
          minimized={chat.minimized}
          focused={focusedId === chat.session.id}
          hasUnsavedSettings={hasUnsavedSettings}
          onApplied={onApplied}
          applyingElsewhere={applying.size > 0}
          onUpdate={updateSession}
          onDraft={(draft) =>
            updateChats((current) =>
              current.map((item) =>
                item.session.id === chat.session.id ? { ...item, draft } : item,
              ),
            )
          }
          onMove={(point) =>
            updateChats((current) =>
              current.map((item) =>
                item.session.id === chat.session.id
                  ? { ...item, position: bounds(item.size, point).position }
                  : item,
              ),
            )
          }
          onResize={(geometry) =>
            updateChats((current) =>
              current.map((item) =>
                item.session.id === chat.session.id
                  ? { ...item, ...bounds(geometry.size, geometry.position) }
                  : item,
              ),
            )
          }
          onFocus={() => focus(chat.session.id)}
          onNew={() => {
            void open(chat.session.scope, true);
          }}
          onMinimize={() => minimize(chat.session.id)}
          onClose={() => close(chat.session.id)}
          onApplyingChange={(value) => applyingChange(chat.session.id, value)}
        />
      ))}
      {opening > 0 && (
        <div className="dock-status" role="status">
          <span className="spinner" />
          Opening conversation…
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {chats.length > 0 && (
        <div className="design-launchers" aria-label="Design chats">
          {chats.map((chat) => {
            const scopeIndex = chats
              .filter((item) => item.session.scope === chat.session.scope)
              .indexOf(chat);
            const firstMessage = chat.session.messages.find((message) => message.role === "user");
            return (
              <button
                key={chat.session.id}
                className={!chat.minimized ? "active" : undefined}
                aria-expanded={!chat.minimized}
                aria-label={
                  designScopes[chat.session.scope].title + (scopeIndex ? ` ${scopeIndex + 1}` : "")
                }
                title={firstMessage?.content ?? designScopes[chat.session.scope].title}
                onClick={() =>
                  focusedId === chat.session.id ? minimize(chat.session.id) : show(chat.session.id)
                }
              >
                <Icon name="spark" size={15} />
                <span>
                  {designScopes[chat.session.scope].title}
                  {chat.session.messages.length > 0 && (
                    <small>{firstMessage?.content.slice(0, 28)}</small>
                  )}
                </span>
                {chat.session.status === "working" && <span className="spinner" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
