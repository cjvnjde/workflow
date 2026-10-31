import { useEffect, useRef } from "react";
import { createApp, defineComponent, h, shallowReactive, type App, type Component } from "vue";

type VueIslandReactProps = {
  component: Component;
  componentProps: Record<string, unknown>;
  className?: string;
};

export function VueIslandReact({ component, componentProps, className }: VueIslandReactProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const mounted = useRef<{ app: App; props: Record<string, unknown> } | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const reactiveProps = shallowReactive({ ...componentProps });
    const rootComponent = defineComponent({
      setup() {
        return () => h(component, { ...reactiveProps });
      },
    });
    const app = createApp(rootComponent);
    app.mount(element);
    mounted.current = { app, props: reactiveProps };

    return () => {
      app.unmount();
      mounted.current = null;
    };
  }, [component]);

  useEffect(() => {
    const current = mounted.current;
    if (!current) return;
    for (const key of Object.keys(current.props)) {
      if (!(key in componentProps)) delete current.props[key];
    }
    Object.assign(current.props, componentProps);
  }, [componentProps]);

  return <div ref={host} className={className} />;
}
