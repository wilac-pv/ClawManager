export type MarketMetricEmitter = (metric: Readonly<Record<string, unknown>>) => void

export function emitMarketMetric(metric: Readonly<Record<string, unknown>>) {
  console.info(JSON.stringify(metric))
}
