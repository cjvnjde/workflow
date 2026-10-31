import { useEffect, useRef } from "react";
import { createApp } from "vue";
import App from "../App.vue";
import { autosize } from "../shared/autosize.js";

/**
 * Temporary compatibility island for feature screens that have not moved to React yet.
 * Keep all legacy UI behavior mounted here until its React replacement is ready.
 */
function LegacyVueApp() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const app = createApp(App);
    app.directive("autosize", autosize);
    app.mount(element);

    return () => app.unmount();
  }, []);

  return <div className="legacy-vue-app" ref={host} />;
}

export function WorkflowApp() {
  return (
    <div className="shadcn-theme">
      <LegacyVueApp />
    </div>
  );
}
