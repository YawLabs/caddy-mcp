export interface Snapshot {
  config: unknown;
  timestamp: number;
  trigger: string;
}

const MAX_SNAPSHOTS = 10;
const store: Snapshot[] = [];

export function saveSnapshot(config: unknown, trigger: string): void {
  store.unshift({ config, timestamp: Date.now(), trigger });
  if (store.length > MAX_SNAPSHOTS) {
    store.length = MAX_SNAPSHOTS;
  }
}

export function listSnapshots(): readonly Snapshot[] {
  return store;
}

export function getSnapshot(index: number): Snapshot | undefined {
  return store[index];
}

export function clearSnapshots(): void {
  store.length = 0;
}
