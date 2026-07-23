const KEY = "studio-plugin-prefs";

export interface PluginGenPrefs {
  input?: string;
  docJson?: string;
  params?: Record<string, string>;
  updatedAt: string;
}

type Store = Record<string, PluginGenPrefs>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Store;
  } catch {
    return {};
  }
}

function write(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store));
}

export function loadPluginPrefs(pluginId: string): PluginGenPrefs | undefined {
  return read()[pluginId];
}

export function savePluginPrefs(
  pluginId: string,
  prefs: Omit<PluginGenPrefs, "updatedAt">,
): void {
  const store = read();
  store[pluginId] = { ...prefs, updatedAt: new Date().toISOString() };
  write(store);
}

export function recentPluginIds(limit = 5): string[] {
  return Object.entries(read())
    .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
    .slice(0, limit)
    .map(([id]) => id);
}
