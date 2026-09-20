export interface TunnelReading {
  readonly up: boolean;
  readonly at: number;
}

export interface TunnelStatus {
  record(envId: string, reading: TunnelReading): void;
  get(envId: string): TunnelReading | undefined;
}

export function createTunnelStatus(): TunnelStatus {
  const readings = new Map<string, TunnelReading>();
  return {
    record: (envId, reading) => { readings.set(envId, reading); },
    get: (envId) => readings.get(envId),
  };
}
