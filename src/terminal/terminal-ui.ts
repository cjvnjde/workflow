import { DynamicBorder, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  type Component,
  type Focusable,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { SecretInput } from "./secret-input.js";

export class WorkflowTerminal {
  readonly tui: TUI;
  private readonly controller = new AbortController();
  private readonly header = new Text("workflow · provider & model setup", 1, 1);
  private removeInputListener: (() => void) | undefined;

  constructor(terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiAltScreen(terminal);
  }

  get signal() {
    return this.controller.signal;
  }

  start() {
    setKeybindings(
      new KeybindingsManager({
        ...TUI_KEYBINDINGS,
        "app.models.save": { defaultKeys: "ctrl+s", description: "Save default model" },
        "app.thinking.save": { defaultKeys: "ctrl+s", description: "Save default thinking" },
        "app.message.copy": { defaultKeys: "ctrl+x", description: "Copy sign-in URL" },
      }),
    );
    initTheme("system", false);
    this.tui.addChild(this.header);
    this.removeInputListener = this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.controller.abort(new Error("Cancelled by user"));
        return { consume: true };
      }

      return undefined;
    });
    this.tui.start();
  }

  mount(component: Component) {
    this.tui.clear();
    this.tui.addChild(this.header);
    this.tui.addChild(component);
    this.tui.setFocus(component);
    this.tui.requestRender();
  }

  async show<T>(
    factory: (done: (value: T) => void, cancel: () => void) => Component & { dispose?: () => void },
    signal = this.signal,
  ) {
    signal.throwIfAborted();
    let component: (Component & { dispose?: () => void }) | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const done = (value?: T) => {
          resolve(value);
        };
        abort = () => {
          reject(new Error("Authentication cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        component = factory(done, () => {
          done();
        });
        this.mount(component);
      });
    } finally {
      if (abort) {
        signal.removeEventListener("abort", abort);
      }
      component?.dispose?.();
    }
  }

  finish(message: string) {
    const colors = getSelectListTheme();
    this.mount(new Text(colors.selectedText(message), 1, 1));
    this.tui.renderNow();
  }

  stop() {
    this.removeInputListener?.();
    this.tui.stop();
  }
}

export class SecretPrompt extends Container implements Focusable {
  private readonly input = new SecretInput();

  constructor(message: string, done: (value: string) => void, cancel: () => void) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(message, 1, 0));
    this.addChild(this.input);
    this.addChild(new Text("Input is hidden · enter to submit · esc to cancel", 1, 0));
    this.addChild(new DynamicBorder());
    this.input.onSubmit = (value) => {
      this.input.setValue("");
      done(value);
    };
    this.input.onEscape = cancel;
  }

  get focused() {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string) {
    this.input.handleInput(data);
  }
}
