type Bridge = NonNullable<Window["__notTaskMenu"]>;
const providers = new Set<{ bridge: Bridge; order: number }>();
const combined: Bridge = {
  prepare() {
    const items = [...providers]
      .sort((a, b) => a.order - b.order)
      .flatMap(({ bridge }) => {
        const item = bridge.prepare();
        return item ? [item] : [];
      });
    return items.length ? { ...items[0], additional: items.slice(1) } : null;
  },
  run(token) {
    for (const { bridge } of providers) {
      if (bridge.prepare()?.token === token) {
        bridge.run(token);
        return;
      }
    }
  },
};
export function registerContextMenu(bridge: Bridge, order: number) {
  const provider = { bridge, order };
  providers.add(provider);
  window.__notTaskMenu = combined;
  return () => {
    providers.delete(provider);
    if (!providers.size && window.__notTaskMenu === combined)
      delete window.__notTaskMenu;
  };
}
