import type { ObjectDirective } from "vue";

/** Fit both typed and programmatically populated fields, including hidden tabs. */
export const autosize: ObjectDirective<
  HTMLTextAreaElement,
  number | undefined
> = {
  mounted(element, binding) {
    let maxRows = binding.value ?? 16;
    let frame = 0;
    let width = -1;
    let disposed = false;
    const fit = () => {
      frame = 0;
      if (disposed || !element.getClientRects().length) return;
      const style = getComputedStyle(element);
      const line =
        parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
      const padding =
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const border =
        parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const maximum = Math.max(
        line + padding + border,
        Math.min(
          maxRows * line + padding + border,
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
      // Height changes are caused by fit itself; only wrapping/visibility needs a refit.
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        schedule();
      }
    });
    observer.observe(element);
    element.addEventListener("input", schedule);
    window.addEventListener("resize", schedule);
    states.set(element, {
      update(rows) {
        maxRows = rows ?? 16;
        schedule();
      },
      dispose() {
        disposed = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        element.removeEventListener("input", schedule);
        window.removeEventListener("resize", schedule);
      },
    });
    fit();
    void document.fonts.ready.then(schedule);
  },
  updated(element, binding) {
    states.get(element)?.update(binding.value);
  },
  unmounted(element) {
    states.get(element)?.dispose();
    states.delete(element);
  },
};
const states = new WeakMap<
  HTMLTextAreaElement,
  {
    update: (rows: number | undefined) => void;
    dispose: () => void;
  }
>();

declare module "vue" {
  interface GlobalDirectives {
    vAutosize: typeof autosize;
  }
}
