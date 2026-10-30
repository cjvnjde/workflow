import {
  BoxRenderable, MarkdownRenderable, ScrollBoxRenderable, SelectRenderable, SyntaxStyle, TextareaRenderable, TextRenderable,
  StyledText, fg, bold, t, type CliRenderer, type KeyEvent, type PasteEvent, type TreeSitterClient,
} from "@opentui/core";
import { TerminalController, commandHelp, type TuiState } from "./controller.js";
import { colors, commands, graphLines, plain, short, transcript, type Card } from "./presentation.js";

type CardView = { box: BoxRenderable; heading: TextRenderable; body: TextRenderable | MarkdownRenderable; signature: string };

export class TerminalWorkspace {
  readonly root: BoxRenderable;
  readonly composer: TextareaRenderable;
  private readonly header: TextRenderable;
  private readonly breadcrumb: TextRenderable;
  private readonly chat: ScrollBoxRenderable;
  private readonly welcome: BoxRenderable;
  private readonly emblem: TextRenderable;
  private readonly suggestions: BoxRenderable;
  private readonly detail: ScrollBoxRenderable;
  private readonly detailTitle: TextRenderable;
  private readonly detailText: TextRenderable;
  private readonly choices: SelectRenderable;
  private readonly graph: BoxRenderable;
  private readonly graphScroll: ScrollBoxRenderable;
  private readonly graphText: TextRenderable;
  private readonly graphTitle: TextRenderable;
  private readonly actions: BoxRenderable;
  private readonly status: TextRenderable;
  private readonly inputBox: BoxRenderable;
  private readonly secretDisplay: TextRenderable;
  private readonly palette: TextRenderable;
  private readonly footer: TextRenderable;
  private readonly syntax: SyntaxStyle;
  private readonly cards = new Map<string, CardView>();
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private secret = "";
  private promptId?: string;
  private currentScreen = "chat";
  private paletteIndex = 0;
  private paletteMatches: (typeof commands)[number][] = [];
  private filteredChoices: TuiState["choices"] = [];
  private choiceSignature = "";
  private actionSignature = "";
  private detailSignature = "";
  private expanded = new Set<string>();
  private readonly onChange = () => this.schedule();
  private readonly onResize = () => this.render();
  private readonly onKey = (key: KeyEvent) => this.key(key);
  private readonly onPaste = (event: PasteEvent) => {
    if (this.isSecret()) {
      event.preventDefault(); event.stopPropagation();
      this.secret = (this.secret + plain(new TextDecoder().decode(event.bytes)).replace(/[\r\n]/g, "")).slice(0, 16_000);
      this.renderSecret();
    }
  };

  constructor(readonly renderer: CliRenderer, readonly controller: TerminalController, private readonly treeSitterClient?: TreeSitterClient) {
    this.syntax = SyntaxStyle.fromStyles({
      default: { fg: colors.text }, "markup.heading": { fg: colors.blue, bold: true },
      "markup.heading.1": { fg: colors.blue, bold: true }, "markup.heading.2": { fg: colors.lavender, bold: true },
      "markup.strong": { fg: colors.text, bold: true }, "markup.list": { fg: colors.mint }, "markup.raw": { fg: colors.mint },
      "markup.link": { fg: colors.blue, underline: true }, comment: { fg: colors.faint }, string: { fg: colors.mint }, keyword: { fg: colors.lavender },
    }, renderer.nativeScene);
    this.root = new BoxRenderable(renderer, { id: "workflow-tui", width: "100%", height: "100%", flexDirection: "column", backgroundColor: colors.base, paddingX: 2, paddingTop: 1 });
    this.header = this.text("header", "", colors.text, 1);
    this.breadcrumb = this.text("breadcrumb", "", colors.muted, 2);
    this.root.add(this.header); this.root.add(this.breadcrumb);
    const content = new BoxRenderable(renderer, { id: "workspace", flexGrow: 1, minHeight: 0, flexDirection: "row", gap: 2 });
    this.root.add(content);
    const main = new BoxRenderable(renderer, { id: "main", flexGrow: 1, minWidth: 0, flexDirection: "column" });
    content.add(main);
    this.chat = new ScrollBoxRenderable(renderer, { id: "conversation", flexGrow: 1, minHeight: 0, stickyScroll: true, stickyStart: "bottom",
      contentOptions: { paddingRight: 1, gap: 1 }, scrollbarOptions: { showArrows: false } });
    main.add(this.chat);
    this.welcome = new BoxRenderable(renderer, { id: "welcome", flexGrow: 1, justifyContent: "center", alignItems: "center", gap: 1, paddingX: 2 });
    const emblem = this.emblem = this.text("emblem", "    ╭───╮\n╭───┤ ◇ ├───╮\n│ ○ ╰─┬─╯ ○ │\n╰─────┼─────╯\n    ╭─┴─╮\n    │ ✓ │\n    ╰───╯", colors.mint);
    this.welcome.add(emblem);
    this.welcome.add(this.text("welcome-title", t`${bold(fg(colors.text)("W O R K F L O W"))}`, colors.text));
    this.welcome.add(this.text("welcome-copy", "A clear path from an idea to working code.", colors.muted));
    this.welcome.add(this.text("welcome-hint", "Describe the work. Review the graph. Follow every step.", colors.faint));
    const suggestions = this.suggestions = new BoxRenderable(renderer, { id: "suggestions", gap: 1, marginTop: 1 });
    for (const [title, description] of [["Investigate", "Find why the tests are failing and propose a fix"], ["Build", "Implement a feature with tests and a review"], ["Review", "Review the project and report actionable findings"]]) {
      suggestions.add(new TextRenderable(renderer, { content: t`${fg(colors.blue)(`${title}  `)}${fg(colors.muted)(description!)}`, wrapMode: "word",
        onMouseDown: () => { this.composer.setText(description!); this.composer.focus(); } }));
    }
    this.welcome.add(suggestions); main.add(this.welcome);
    this.detail = new ScrollBoxRenderable(renderer, { id: "detail", flexGrow: 1, minHeight: 0, contentOptions: { gap: 1, paddingRight: 1 }, visible: false });
    this.detailTitle = this.text("detail-title", "", colors.lavender);
    this.detailText = this.text("detail-text", "", colors.text);
    this.detail.add(this.detailTitle); this.detail.add(this.detailText); main.add(this.detail);
    this.choices = new SelectRenderable(renderer, { id: "choices", flexGrow: 1, minHeight: 0, visible: false,
      backgroundColor: colors.base, textColor: colors.text, descriptionColor: colors.muted,
      selectedBackgroundColor: colors.raised, selectedTextColor: colors.mint, selectedDescriptionColor: colors.muted,
      showDescription: true, showScrollIndicator: true, wrapSelection: true, itemSpacing: 1 });
    main.add(this.choices);
    this.graph = new BoxRenderable(renderer, { id: "graph-panel", width: 37, border: ["left"], borderColor: colors.border, paddingLeft: 2, flexDirection: "column", visible: false });
    this.graphTitle = this.text("graph-title", "WORKFLOW", colors.lavender);
    this.graph.add(this.graphTitle);
    this.graphScroll = new ScrollBoxRenderable(renderer, { id: "graph-scroll", flexGrow: 1, minHeight: 0, contentOptions: { paddingTop: 1 } });
    this.graphText = this.text("graph-text", "", colors.text);
    this.graphScroll.add(this.graphText); this.graph.add(this.graphScroll); content.add(this.graph);
    this.actions = new BoxRenderable(renderer, { id: "actions", flexDirection: "row", gap: 1, marginTop: 1, height: 1, visible: false });
    this.root.add(this.actions);
    this.status = this.text("status", "", colors.muted, 1); this.root.add(this.status);
    this.palette = this.text("command-palette", "", colors.text);
    this.palette.visible = false; this.root.add(this.palette);
    this.inputBox = new BoxRenderable(renderer, { id: "composer-box", border: true, borderStyle: "rounded", borderColor: colors.border,
      backgroundColor: colors.panel, paddingX: 1, height: 5, title: " Message ", titleColor: colors.mint });
    this.root.add(this.inputBox);
    this.composer = new TextareaRenderable(renderer, { id: "composer", width: "100%", height: 3, wrapMode: "word",
      backgroundColor: colors.panel, focusedBackgroundColor: colors.panel, textColor: colors.text, cursorColor: colors.mint,
      placeholder: "What would you like to work on?", placeholderColor: colors.faint,
      keyBindings: [{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "j", ctrl: true, action: "newline" }],
      onSubmit: () => { void this.send(); }, onContentChange: () => this.inputChanged(),
    });
    this.inputBox.add(this.composer);
    this.secretDisplay = this.text("secret-input", "", colors.mint, 2); this.secretDisplay.visible = false; this.inputBox.add(this.secretDisplay);
    this.footer = this.text("footer", "", colors.faint, 2); this.root.add(this.footer);
    renderer.root.add(this.root);
    renderer.keyInput.on("keypress", this.onKey); renderer.keyInput.on("paste", this.onPaste);
    renderer.on("resize", this.onResize); controller.on("change", this.onChange);
    this.composer.focus(); this.render();
  }
  private text(id: string, content: string | StyledText, color: string, height?: number) {
    return new TextRenderable(this.renderer, { id, content, fg: color, wrapMode: "word", flexShrink: 0, ...(height ? { height } : {}) });
  }
  private schedule() {
    if (this.timer || this.destroyed) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 60);
  }
  private isSecret() {
    const state = this.controller.state;
    return state.screen === "auth" && state.auth?.status === "pending" && ["secret", "manual_code"].includes(state.auth.prompt?.type ?? "");
  }
  private renderSecret() { this.secretDisplay.content = this.secret ? "●".repeat(Math.min([...this.secret].length, 48)) : "Paste your secret here · input is hidden"; }
  private inputChanged() {
    if (this.destroyed) return;
    this.paletteIndex = 0;
    this.updatePalette();
    if (this.controller.state.screen === "picker") this.updateChoices();
  }
  private updatePalette() {
    const value = this.composer.plainText;
    this.paletteMatches = value.startsWith("/") && !/\s/.test(value) && !this.isSecret() ? commands.filter(([name]) => name.startsWith(value)).slice(0, 6) : [];
    this.palette.visible = !!this.paletteMatches.length;
    if (this.palette.visible) this.palette.content = new StyledText(this.paletteMatches.map(([name, description], index) =>
      fg(index === this.paletteIndex ? colors.mint : colors.muted)(`${index === this.paletteIndex ? "›" : " "} ${name.padEnd(12)} ${description}\n`)));
  }
  private updateChoices() {
    const search = this.composer.plainText.toLowerCase();
    this.filteredChoices = this.controller.state.choices.filter(choice => `${choice.label} ${choice.detail}`.toLowerCase().includes(search));
    const signature = JSON.stringify(this.filteredChoices);
    if (signature !== this.choiceSignature) {
      this.choiceSignature = signature;
      this.choices.options = this.filteredChoices.map(choice => ({ name: plain(choice.label), description: plain(choice.detail), value: choice.id }));
      this.choices.setSelectedIndex(0);
    }
  }
  private key(key: KeyEvent) {
    if (this.destroyed || key.eventType === "release") return;
    const stop = () => { key.preventDefault(); key.stopPropagation(); };
    if (key.ctrl && key.name === "c") { stop(); this.controller.emit("quit"); return; }
    if (this.isSecret()) {
      stop();
      if (key.name === "escape") {
        this.secret = ""; void this.controller.perform("Cancelling sign-in", () => this.controller.cancelAuth());
      } else if (key.name === "return") {
        const value = this.secret; this.secret = ""; this.renderSecret();
        if (value) void this.controller.perform("Signing in", () => this.controller.respondAuth(value));
      } else if (key.name === "backspace") this.secret = [...this.secret].slice(0, -1).join("");
      else if (key.ctrl && (key.name === "u" || key.name === "w")) this.secret = "";
      else if (!key.ctrl && !key.meta && !key.super && key.sequence && !key.sequence.startsWith("\x1b")) this.secret = (this.secret + plain(key.sequence)).slice(0, 16_000);
      this.renderSecret(); return;
    }
    if (key.ctrl && key.name === "n") { stop(); this.composer.setText(""); this.controller.newSession(); return; }
    if (key.ctrl && key.name === "g") { stop(); if (this.controller.state.screen === "graph") this.controller.back(); else void this.controller.submit("/graph"); return; }
    if (key.ctrl && key.name === "p") { stop(); this.composer.setText(""); void this.controller.submit("/sessions"); return; }
    if (key.name === "escape") {
      stop(); this.composer.setText("");
      if (this.controller.state.screen === "auth" && this.controller.state.auth?.status === "pending") void this.controller.perform("Cancelling sign-in", () => this.controller.cancelAuth());
      else this.controller.back();
      this.composer.focus(); return;
    }
    if (this.paletteMatches.length && ["up", "down", "tab"].includes(key.name)) {
      stop();
      if (key.name === "tab") this.composer.setText(`${this.paletteMatches[this.paletteIndex]![0]} `);
      else { this.paletteIndex = (this.paletteIndex + (key.name === "up" ? -1 : 1) + this.paletteMatches.length) % this.paletteMatches.length; this.updatePalette(); }
      return;
    }
    if (this.controller.state.screen === "picker" && !this.composer.plainText.startsWith("/") && ["up", "down", "return"].includes(key.name)) {
      stop();
      if (key.name === "up") this.choices.moveUp();
      else if (key.name === "down") this.choices.moveDown();
      else {
        const choice = this.filteredChoices[this.choices.getSelectedIndex()];
        if (choice) { this.composer.setText(""); void this.controller.choose(choice.id); }
      }
      return;
    }
    if (["pageup", "pagedown"].includes(key.name)) {
      stop(); const scroll = this.controller.state.screen === "chat" ? this.chat : this.detail;
      scroll.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
    }
  }
  private async send() {
    this.updatePalette();
    let value = this.composer.plainText;
    if (this.paletteMatches.length) value = this.paletteMatches[this.paletteIndex]![0];
    if (!value.trim()) return;
    if (this.controller.state.busy && !["/cancel", "/quit", "/exit"].includes(value.trim())) return;
    this.composer.setText("");
    await this.controller.submit(value);
    // Keep failed requests editable. Never retain authentication input.
    if (this.controller.state.error && !value.startsWith("/") && this.controller.state.screen !== "auth" && !this.composer.plainText) this.composer.setText(value);
    this.composer.focus();
  }
  private syncCards(cards: Card[]) {
    const ids = new Set(cards.map(card => card.id));
    for (const [id, view] of this.cards) if (!ids.has(id)) { this.chat.remove(view.box); view.box.destroyRecursively(); this.cards.delete(id); }
    for (const [index, card] of cards.entries()) {
      let view = this.cards.get(card.id);
      if (!view) {
        const box = new BoxRenderable(this.renderer, { id: `card-${card.id}`, border: ["left"], borderColor: colors[card.tone], paddingLeft: 2, paddingY: 1, flexShrink: 0, backgroundColor: card.id === "request" ? colors.panel : colors.base });
        const heading = this.text(`card-title-${card.id}`, "", colors[card.tone]);
        const body = card.markdown ? new MarkdownRenderable(this.renderer, { id: `card-body-${card.id}`, content: "", syntaxStyle: this.syntax, treeSitterClient: this.treeSitterClient, conceal: true, fg: colors.text, streaming: !!card.live, flexShrink: 0 })
          : this.text(`card-body-${card.id}`, "", colors.text);
        box.add(heading); box.add(body); this.chat.add(box, index);
        view = { box, heading, body, signature: "" }; this.cards.set(card.id, view);
        box.onMouseDown = () => { this.expanded.has(card.id) ? this.expanded.delete(card.id) : this.expanded.add(card.id); this.render(); };
      }
      const collapsed = !card.markdown && card.id !== "request" && !this.expanded.has(card.id);
      const lines = card.body.split("\n");
      const body = collapsed && (lines.length > 6 || card.body.length > 650) ? `${lines.slice(0, 6).join("\n").slice(0, 650)}\n… click to expand` : card.body;
      const signature = `${card.title}\n${body}`;
      if (signature !== view.signature) {
        view.signature = signature; view.heading.content = t`${bold(fg(colors[card.tone])(card.title))}`;
        view.body.content = body;
        if (view.body instanceof MarkdownRenderable) view.body.streaming = !!card.live;
      }
    }
  }
  private renderActions(state: TuiState) {
    const run = state.run;
    const signature = `${state.screen}/${run?.id}/${run?.status}/${state.task?.status}`;
    if (signature === this.actionSignature) return;
    this.actionSignature = signature;
    for (const child of this.actions.getChildren()) { this.actions.remove(child); child.destroyRecursively(); }
    const buttons: [string, string, string][] = [];
    if (run?.status === "draft") buttons.push([" Approve & start ", "/approve", colors.mint], [" Reject ", "/reject", colors.red], [" View source ", "/source", colors.muted]);
    else if (run?.status === "running") buttons.push([" Pause ", "/pause", colors.yellow], [" Cancel ", "/cancel", colors.red]);
    else if (run && ["paused", "interrupted"].includes(run.status)) buttons.push([" Resume / retry ", "/resume", colors.mint], [" Cancel ", "/cancel", colors.red]);
    else if (state.task && ["planning", "queued", "needs_input"].includes(state.task.status)) buttons.push([" Stop planning ", "/cancel", colors.red]);
    else if (state.task && ["failed", "cancelled"].includes(state.task.status) && !state.task.runId) buttons.push([" Retry planning ", "/retry", colors.yellow]);
    for (const [label, command, color] of buttons) {
      this.actions.add(new TextRenderable(this.renderer, { content: label, fg: color, bg: colors.raised, height: 1, onMouseDown: () => { void this.controller.submit(command); } }));
    }
    this.actions.visible = buttons.length > 0 && ["chat", "graph"].includes(state.screen);
  }
  render() {
    if (this.destroyed) return;
    const state = this.controller.state;
    const width = this.renderer.width;
    const compact = this.renderer.height < 30;
    this.emblem.visible = !compact; this.suggestions.visible = !compact;
    this.root.paddingLeft = width < 70 ? 1 : 2; this.root.paddingRight = width < 70 ? 1 : 2;
    this.inputBox.height = compact ? 4 : 5; this.composer.height = compact ? 2 : 3;
    const project = state.project?.project.split(/[\\/]/).filter(Boolean).at(-1) ?? "connecting";
    this.header.content = t`${bold(fg(colors.mint)(" ◈ WORKFLOW"))}${fg(colors.muted)(`  / ${short(project, Math.max(10, width - 50))}`)}${fg(state.connected ? colors.mint : colors.yellow)(state.connected ? "    ● connected" : "    ◌ reconnecting")}${fg(colors.yellow)(state.project?.mode === "demo" ? "  DEMO" : "")}`;
    this.breadcrumb.content = state.task || state.run ? `${short(state.run?.plan.title ?? state.task?.prompt ?? "", Math.max(10, width - 8))}\n${state.run?.status ?? state.task?.status}  ·  ${state.run ? `${state.run.attempts.filter(attempt => attempt.finishedAt).length} attempts finished` : "composing your workflow"}`
      : "Your terminal workspace for deliberate, observable automation.";
    if (this.currentScreen !== state.screen) {
      this.currentScreen = state.screen; this.choiceSignature = ""; this.detailSignature = "";
      this.composer.setText(""); this.detail.scrollTo(0);
    }
    const chatting = state.screen === "chat";
    this.chat.visible = chatting && !!(state.task || state.run);
    this.welcome.visible = chatting && !state.task && !state.run;
    this.graph.visible = chatting && !!state.run && width >= 110;
    this.choices.visible = state.screen === "picker";
    this.detail.visible = !chatting;
    this.detail.flexGrow = state.screen === "picker" ? 0 : 1;
    this.detail.height = state.screen === "picker" ? Math.min(compact ? 4 : 7, state.panelDescription.split("\n").length + 3) : "auto";
    if (chatting) this.syncCards(transcript(state.task, state.run, state.events, state.live));
    if (state.run) {
      const lines = graphLines(state.run);
      this.graphText.content = new StyledText(lines.map(line => fg(colors[line.tone])(`${line.text}\n`)));
      this.graphTitle.content = t`${bold(fg(colors.lavender)("WORKFLOW"))}\n${fg(state.run.status === "draft" ? colors.yellow : colors.muted)(state.run.status === "draft" ? "Review before execution" : state.run.status)}\n${fg(colors.faint)("/graph to expand · /step to inspect")}`;
      if (state.screen === "graph") this.setDetail("Workflow graph", new StyledText([
        fg(colors.muted)(`${state.run.plan.title}\n${state.run.status.toUpperCase()} · revision ${state.run.revision}\n\n`),
        ...lines.map(line => fg(colors[line.tone])(`${line.text}\n`)),
        fg(colors.faint)("\n/approve to start · /reject to decline · /step for details · /source for code"),
      ]));
      if (state.screen === "source") this.setDetail("Workflow source · read only", plain(state.run.program?.source ?? JSON.stringify(state.run.plan, null, 2)));
    }
    if (state.screen === "picker") { this.setDetail(state.panelTitle, plain(state.panelDescription)); this.updateChoices(); }
    if (state.screen === "step" || state.screen === "session") this.setDetail(state.panelTitle, plain(state.detail));
    if (state.screen === "help") this.setDetail("Make yourself at home", `${commandHelp}\n\nEnter         Send message or run command\nShift+Enter   New line (Ctrl+J also works)\nTab           Complete a slash command\n↑ / ↓         Choose commands or picker items\nCtrl+N        New session\nCtrl+P        Session history\nCtrl+G        Toggle graph\nPgUp / PgDn   Scroll activity\nEsc           Return to conversation\nCtrl+C        Close workspace\n\nClick a tool card to expand its output.\nWhile a draft is open, a message asks the planner to refine it.\nAfter completion, a message creates another task.\nAutomatic approval applies to new tasks only.`);
    if (state.screen === "auth") {
      const auth = state.auth;
      const lines = auth?.events.flatMap(event => event.type === "auth_url" ? [event.url, event.instructions ?? ""]
        : event.type === "device_code" ? [`Open ${event.verificationUri}`, `Your code: ${event.userCode}`]
        : event.type === "info" ? [event.message, ...(event.links ?? []).map(link => `${link.label ?? "Open"}: ${link.url}`)] : [event.message]) ?? [];
      this.setDetail(`Connect · ${auth?.provider ?? "provider"}`, plain([auth?.message ?? "Follow the provider's sign-in instructions.", ...lines,
        auth?.prompt?.message ?? (auth?.status === "pending" ? "Waiting for the provider…" : "Press Esc to return. Use /models to select a model."),
        ...(auth?.prompt?.options ?? []).map((option, i) => `${i + 1}. ${option.label}  ${option.description ?? ""}`),
        "\nEsc cancels an unfinished sign-in. Secrets never appear in the conversation.",
      ].join("\n\n")));
    }
    const secret = this.isSecret();
    if (this.promptId !== state.auth?.prompt?.id || !secret) { this.secret = ""; this.promptId = state.auth?.prompt?.id; }
    this.secretDisplay.visible = secret; this.composer.visible = !secret;
    if (secret) { this.composer.blur(); this.renderSecret(); } else if (!this.composer.focused) this.composer.focus();
    this.inputBox.title = secret ? " Hidden input " : state.screen === "picker" ? " Filter · ↑ ↓ select · Enter open "
      : state.task?.status === "needs_input" ? " Your answer " : state.run?.status === "draft" ? " Refine the plan · or /approve " : " Message ";
    this.inputBox.borderColor = secret ? colors.yellow : this.composer.focused ? colors.mint : colors.border;
    this.composer.placeholder = state.screen === "picker" ? "Type to filter…" : state.screen === "auth" ? "Respond to the provider prompt…"
      : state.task?.status === "needs_input" ? "Type your answer, or choose an option number…" : "Describe a task, or type / for commands…";
    this.status.content = short(state.error || state.busy || state.notice || (state.run?.status === "draft" ? "Review the graph and source, then approve when you are ready." : ""), Math.max(20, width - 6));
    this.status.fg = state.error ? colors.red : state.busy ? colors.blue : colors.muted;
    const agent = { ...state.setup?.userAgent, ...state.setup?.projectAgent };
    this.footer.content = new StyledText([
      fg(state.approval === "automatic" ? colors.yellow : colors.mint)(state.approval === "automatic" ? "AUTO APPROVAL" : "REVIEW FIRST"),
      fg(colors.muted)(`  ·  ${short(agent.model ?? "No model · /login to connect", Math.max(15, width - 50))}`),
      fg(colors.faint)(`\n${width >= 75 ? "Enter send  ·  Shift+Enter newline  ·  Ctrl+G graph  ·  " : ""}/web browser  ·  / commands  ·  Ctrl+C quit`),
    ]);
    this.renderActions(state); this.updatePalette();
  }
  private setDetail(title: string, body: string | StyledText) {
    const signature = title + (typeof body === "string" ? body : JSON.stringify(body.chunks));
    if (signature === this.detailSignature) return;
    this.detailSignature = signature; this.detailTitle.content = t`${bold(fg(colors.lavender)(title))}`; this.detailText.content = body;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; clearTimeout(this.timer); this.secret = "";
    this.controller.off("change", this.onChange); this.renderer.off("resize", this.onResize);
    this.renderer.keyInput.off("keypress", this.onKey); this.renderer.keyInput.off("paste", this.onPaste);
    this.root.destroyRecursively(); this.syntax.destroy();
  }
}
