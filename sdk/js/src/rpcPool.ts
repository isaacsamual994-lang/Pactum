import { rpc } from '@stellar/stellar-sdk';

/**
 * Reliability settings for the Pactum Soroban RPC transport.
 * Hedging is confined to idempotent reads and simulation. A signed transaction
 * is never submitted again automatically: a transport failure may mean that
 * the first submission actually reached the network.
 */
export interface RpcPoolOptions {
  /** EWMA smoothing factor for latency, success, and rate-limit health (0, 1]. */
  ewmaAlpha?: number;
  /** Fallback hedge delay before enough latency samples have been observed. */
  initialHedgeDelayMs?: number;
  /** Bounds for the rolling p95-based hedge delay. */
  minHedgeDelayMs?: number;
  maxHedgeDelayMs?: number;
  /** Maximum duration of a single read attempt. */
  requestTimeoutMs?: number;
  /** Exponential health-cooldown settings after a failed attempt. */
  backoffBaseMs?: number;
  maxBackoffMs?: number;
}

export interface RpcNodeHealth {
  url: string;
  latencyEwmaMs: number;
  successRateEwma: number;
  rateLimitRateEwma: number;
  consecutiveFailures: number;
  coolingUntil: number;
  observedP95Ms: number | null;
}

interface RpcNode extends RpcNodeHealth {
  server: rpc.Server;
  latencySamples: number[];
}

type RpcServerFactory = (url: string) => rpc.Server;

// Only operations with no network mutation may be hedged or retried.
// simulateTransaction is read-only; sendTransaction is intentionally excluded.
const IDEMPOTENT_READS = new Set([
  'getAccount',
  'getTransaction',
  'pollTransaction',
  'simulateTransaction',
  'getLatestLedger',
  'getLedgerEntries',
  'getContractData',
  'getEvents',
  'getFeeStats',
  'getHealth',
  'getNetwork',
]);

const DEFAULTS: Required<RpcPoolOptions> = {
  ewmaAlpha: 0.25,
  initialHedgeDelayMs: 180,
  minHedgeDelayMs: 40,
  maxHedgeDelayMs: 1500,
  requestTimeoutMs: 12000,
  backoffBaseMs: 250,
  maxBackoffMs: 10000,
};

function checkPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Pactum RPC pool: ' + name + ' must be a positive finite number.');
  }
}

function isRateLimited(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const e = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
    message?: string;
  };
  return e.status === 429
    || e.statusCode === 429
    || e.response?.status === 429
    || (typeof e.message === 'string' && /\b429\b|rate.limit/i.test(e.message));
}

function percentile95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

/**
 * A per-client connection pool. Each RPC endpoint maintains independent
 * rolling health and p95 latency history. Connection-health cooldowns are
 * exponential; each successful call restores the endpoint for future ranking.
 */
export class SorobanRpcPool {
  private readonly nodes: RpcNode[];
  private readonly options: Required<RpcPoolOptions>;
  /** Compatible with the existing TxOptions.rpcServer integration surface. */
  readonly server: rpc.Server;

  constructor(
    urls: string[],
    options: RpcPoolOptions = {},
    factory: RpcServerFactory = (url) => new rpc.Server(url, { allowHttp: false }),
  ) {
    if (!Array.isArray(urls) || urls.length === 0 || urls.some((u) => typeof u !== 'string' || !u.trim())) {
      throw new Error('Pactum RPC pool: at least one nonempty RPC URL is required.');
    }
    const unique = [...new Set(urls.map((u) => u.trim()))];
    this.options = { ...DEFAULTS, ...options };
    checkPositive('ewmaAlpha', this.options.ewmaAlpha);
    if (this.options.ewmaAlpha > 1) {
      throw new Error('Pactum RPC pool: ewmaAlpha must not exceed 1.');
    }
    for (const key of [
      'initialHedgeDelayMs',
      'minHedgeDelayMs',
      'maxHedgeDelayMs',
      'requestTimeoutMs',
      'backoffBaseMs',
      'maxBackoffMs',
    ] as const) {
      checkPositive(key, this.options[key]);
    }
    if (this.options.minHedgeDelayMs > this.options.maxHedgeDelayMs) {
      throw new Error('Pactum RPC pool: minHedgeDelayMs cannot exceed maxHedgeDelayMs.');
    }

    this.nodes = unique.map((url) => ({
      url,
      server: factory(url),
      latencyEwmaMs: this.options.initialHedgeDelayMs,
      successRateEwma: 1,
      rateLimitRateEwma: 0,
      consecutiveFailures: 0,
      coolingUntil: 0,
      observedP95Ms: null,
      latencySamples: [],
    }));

    // Other non-I/O Server properties retain their original behavior. We wrap
    // only the selected RPC calls used by PactumClient and its TxOptions.
    const primary = this.nodes[0].server;
    this.server = new Proxy(primary, {
      get: (target, property, receiver) => {
        if (typeof property === 'string' && IDEMPOTENT_READS.has(property)) {
          return (...args: unknown[]) => this.read(property, args);
        }
        if (property === 'sendTransaction') {
          return (...args: unknown[]) => this.submitOnce('sendTransaction', args);
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  getHealth(): RpcNodeHealth[] {
    return this.nodes.map((node) => ({
      url: node.url,
      latencyEwmaMs: node.latencyEwmaMs,
      successRateEwma: node.successRateEwma,
      rateLimitRateEwma: node.rateLimitRateEwma,
      consecutiveFailures: node.consecutiveFailures,
      coolingUntil: node.coolingUntil,
      observedP95Ms: percentile95(node.latencySamples),
    }));
  }

  private score(node: RpcNode): number {
    return (node.successRateEwma * (1 - node.rateLimitRateEwma))
      / Math.max(1, node.latencyEwmaMs);
  }

  private ranked(): RpcNode[] {
    const now = Date.now();
    return [...this.nodes].sort((a, b) => {
      const aCooling = a.coolingUntil > now;
      const bCooling = b.coolingUntil > now;
      if (aCooling !== bCooling) return aCooling ? 1 : -1;
      // When all nodes are cooling, retry the one whose cooldown ends first.
      if (aCooling && bCooling) return a.coolingUntil - b.coolingUntil;
      return this.score(b) - this.score(a);
    });
  }

  private hedgeDelay(node: RpcNode): number {
    const p95 = percentile95(node.latencySamples);
    return Math.min(
      this.options.maxHedgeDelayMs,
      Math.max(this.options.minHedgeDelayMs, p95 ?? this.options.initialHedgeDelayMs),
    );
  }

  private success(node: RpcNode, latencyMs: number): void {
    const a = this.options.ewmaAlpha;
    node.latencyEwmaMs = a * latencyMs + (1 - a) * node.latencyEwmaMs;
    node.successRateEwma = a + (1 - a) * node.successRateEwma;
    node.rateLimitRateEwma *= 1 - a;
    node.consecutiveFailures = 0;
    node.coolingUntil = 0;
    node.latencySamples.push(latencyMs);
    if (node.latencySamples.length > 64) node.latencySamples.shift();
    node.observedP95Ms = percentile95(node.latencySamples);
  }

  private failure(node: RpcNode, error: unknown): void {
    const a = this.options.ewmaAlpha;
    node.successRateEwma *= 1 - a;
    const rateLimited = isRateLimited(error);
    node.rateLimitRateEwma = a * (rateLimited ? 1 : 0) + (1 - a) * node.rateLimitRateEwma;
    node.consecutiveFailures += 1;
    const power = Math.min(node.consecutiveFailures - 1, 12);
    const cooldown = Math.min(
      this.options.maxBackoffMs,
      this.options.backoffBaseMs * (2 ** power) * (rateLimited ? 2 : 1),
    );
    node.coolingUntil = Date.now() + cooldown;
  }

  private async call<T>(node: RpcNode, method: string, args: unknown[]): Promise<T> {
    const candidate = (node.server as unknown as Record<string, unknown>)[method];
    if (typeof candidate !== 'function') {
      throw new Error('Pactum RPC pool: endpoint does not support ' + method + '.');
    }

    // Timeouts don't cancel SDK requests; late responses are discarded. Only
    // reads are hedged, while write timeouts are surfaced as ambiguous errors.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => (candidate as (...xs: unknown[]) => Promise<T>).apply(node.server, args)),
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Pactum RPC pool: ' + method + ' timed out.')),
            this.options.requestTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /**
   * Starts with the healthiest node; if its response exceeds that node's
   * observed p95, launch one speculative backup. A failing node triggers
   * immediate failover, and further candidates are used only as needed.
   * At most two endpoint reads for a request are in-flight simultaneously.
   */
  private read<T>(method: string, args: unknown[]): Promise<T> {
    const candidates = this.ranked();
    return new Promise<T>((resolve, reject) => {
      let cursor = 0;
      let active = 0;
      let finished = false;
      let lastError: unknown;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

      const clearHedge = (): void => {
        if (hedgeTimer !== undefined) {
          clearTimeout(hedgeTimer);
          hedgeTimer = undefined;
        }
      };

      const schedule = (node: RpcNode): void => {
        if (finished || active >= 2 || cursor >= candidates.length || hedgeTimer !== undefined) return;
        hedgeTimer = setTimeout(() => {
          hedgeTimer = undefined;
          if (!finished && active > 0 && active < 2) launch();
        }, this.hedgeDelay(node));
      };

      const launch = (): void => {
        if (finished || cursor >= candidates.length || active >= 2) return;
        clearHedge();
        const node = candidates[cursor++];
        const start = Date.now();
        active += 1;
        void this.call<T>(node, method, args).then(
          (value) => {
            active -= 1;
            this.success(node, Math.max(1, Date.now() - start));
            if (!finished) {
              finished = true;
              clearHedge();
              resolve(value);
            }
          },
          (error: unknown) => {
            active -= 1;
            this.failure(node, error);
            lastError = error;
            if (finished) return;
            if (cursor < candidates.length && active < 2) launch();
            if (active === 0 && cursor >= candidates.length) {
              finished = true;
              clearHedge();
              reject(lastError);
            }
          },
        );
        schedule(node);
      };

      launch();
    });
  }

  /**
   * A signed transaction is dispatched exactly once, to one chosen node.
   * On any network error or timeout, the caller must reconcile by transaction
   * hash before deciding whether to resubmit.
   */
  private async submitOnce<T>(method: string, args: unknown[]): Promise<T> {
    const node = this.ranked()[0];
    const start = Date.now();
    try {
      const result = await this.call<T>(node, method, args);
      this.success(node, Math.max(1, Date.now() - start));
      return result;
    } catch (error) {
      this.failure(node, error);
      throw error;
    }
  }
}
