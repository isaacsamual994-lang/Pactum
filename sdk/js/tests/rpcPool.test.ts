import { describe, expect, it, vi } from 'vitest';
import type { rpc } from '@stellar/stellar-sdk';
import { PactumClient } from '../src/client';
import { SorobanRpcPool } from '../src/rpcPool';
import { resolveNetwork } from '../src/networks';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type FakeServer = Partial<Record<
  'getAccount' | 'simulateTransaction' | 'getTransaction' | 'getEvents' | 'sendTransaction',
  (...args: unknown[]) => Promise<unknown>
>>;

function pool(
  servers: Record<string, FakeServer>,
  options: ConstructorParameters<typeof SorobanRpcPool>[1] = {},
): SorobanRpcPool {
  return new SorobanRpcPool(Object.keys(servers), options, (url) => servers[url] as rpc.Server);
}

describe('Pactum RPC endpoint configuration', () => {
  it('preserves single-URL network defaults', () => {
    const preset = resolveNetwork('testnet');
    expect(preset.rpcUrls).toEqual([preset.rpcUrl]);
    expect(preset.networkPassphrase).toContain('Test SDF Network');
  });

  it('accepts an ordered custom endpoint list and overrides the single URL', () => {
    const config = resolveNetwork(
      'custom',
      'https://legacy.test',
      'My passphrase',
      ['https://primary.test', 'https://backup.test'],
    );
    expect(config.rpcUrl).toBe('https://primary.test');
    expect(config.rpcUrls).toEqual(['https://primary.test', 'https://backup.test']);
    expect(config.networkPassphrase).toBe('My passphrase');
  });

  it('rejects missing endpoints and invalid settings', () => {
    expect(() => resolveNetwork('custom', undefined, 'some network', [])).toThrow('nonempty array');
    expect(() => new SorobanRpcPool([])).toThrow('at least one');
    expect(() => new SorobanRpcPool(['https://a.test'], { ewmaAlpha: 0 })).toThrow('ewmaAlpha');
    expect(() => new SorobanRpcPool(['https://a.test'], {
      minHedgeDelayMs: 200,
      maxHedgeDelayMs: 50,
    })).toThrow('minHedgeDelayMs');
  });

  it('exposes health without making network requests', () => {
    const client = new PactumClient({
      network: 'testnet',
      rpcUrls: ['https://one.example', 'https://two.example'],
    });
    expect(client.getRpcHealth().map((n) => n.url)).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
  });
});

describe('RPC failover and read-only hedging', () => {
  it('uses the chosen node and remembers successful latency samples', async () => {
    const a = vi.fn(async () => 'account-primary');
    const connection = pool({ 'https://a.test': { getAccount: a } });
    await expect(connection.server.getAccount('GTEST')).resolves.toBe('account-primary');
    expect(a).toHaveBeenCalledOnce();
    const [health] = connection.getHealth();
    expect(health.successRateEwma).toBe(1);
    expect(health.observedP95Ms).not.toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it('fails over on 429, penalizes the rate-limited node, and uses the healthy node next', async () => {
    const a = vi.fn(async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); });
    const b = vi.fn(async () => 'backup-result');
    const connection = pool({
      'https://a.test': { getAccount: a },
      'https://b.test': { getAccount: b },
    }, { backoffBaseMs: 400, initialHedgeDelayMs: 250 });

    await expect(connection.server.getAccount('GTEST')).resolves.toBe('backup-result');
    const limited = connection.getHealth()[0];
    expect(limited.rateLimitRateEwma).toBeGreaterThan(0);
    expect(limited.successRateEwma).toBeLessThan(1);
    expect(limited.coolingUntil).toBeGreaterThan(Date.now());

    await expect(connection.server.getAccount('GTEST')).resolves.toBe('backup-result');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('hedges read-only simulation when the primary exceeds its p95 delay', async () => {
    const slow = vi.fn(async () => { await sleep(90); return 'slow-value'; });
    const fast = vi.fn(async () => { await sleep(2); return 'fast-value'; });
    const connection = pool({
      'https://a.test': { simulateTransaction: slow },
      'https://b.test': { simulateTransaction: fast },
    }, { initialHedgeDelayMs: 20, minHedgeDelayMs: 15 });

    const start = Date.now();
    await expect(connection.server.simulateTransaction({} as never)).resolves.toBe('fast-value');
    expect(Date.now() - start).toBeLessThan(75);
    expect(slow).toHaveBeenCalledOnce();
    expect(fast).toHaveBeenCalledOnce();
  });

  it('uses a third node if the first two fail rather than aborting a usable query', async () => {
    const connection = pool({
      'https://a.test': { getTransaction: async () => { throw new Error('offline A'); } },
      'https://b.test': { getTransaction: async () => { throw new Error('offline B'); } },
      'https://c.test': { getTransaction: async () => 'ledger-result' },
    }, { initialHedgeDelayMs: 200 });

    await expect(connection.server.getTransaction('tx')).resolves.toBe('ledger-result');
    expect(connection.getHealth().slice(0, 2).every((n) => n.consecutiveFailures === 1)).toBe(true);
  });

  it('times out a hanging read and safely switches to another endpoint', async () => {
    const hanging = vi.fn(() => new Promise<unknown>(() => undefined));
    const ok = vi.fn(async () => 'recovered');
    const connection = pool({
      'https://a.test': { getEvents: hanging },
      'https://b.test': { getEvents: ok },
    }, {
      requestTimeoutMs: 25,
      initialHedgeDelayMs: 120,
      minHedgeDelayMs: 100,
    });
    await expect(connection.server.getEvents({} as never)).resolves.toBe('recovered');
    expect(hanging).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
  });

  it('surfaces an error when every available node fails', async () => {
    const connection = pool({
      'https://a.test': { getAccount: async () => { throw new Error('offline A'); } },
      'https://b.test': { getAccount: async () => { throw new Error('offline B'); } },
    });
    await expect(connection.server.getAccount('GTEST')).rejects.toThrow('offline');
  });
});

describe('signed transaction submission safety', () => {
  it('NEVER resubmits on a different RPC node after an ambiguous submission failure', async () => {
    const primary = vi.fn(async () => { throw new Error('connection reset after submit'); });
    const secondary = vi.fn(async () => 'must-not-run');
    const connection = pool({
      'https://a.test': { sendTransaction: primary },
      'https://b.test': { sendTransaction: secondary },
    });

    await expect(connection.server.sendTransaction({} as never)).rejects.toThrow('connection reset');
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).not.toHaveBeenCalled();
  });

  it('does not hedge or retry a timed-out signed transaction either', async () => {
    const hanging = vi.fn(() => new Promise<unknown>(() => undefined));
    const secondary = vi.fn(async () => 'should-never-submit');
    const connection = pool({
      'https://a.test': { sendTransaction: hanging },
      'https://b.test': { sendTransaction: secondary },
    }, { requestTimeoutMs: 20, initialHedgeDelayMs: 5, minHedgeDelayMs: 5 });

    await expect(connection.server.sendTransaction({} as never)).rejects.toThrow('timed out');
    expect(hanging).toHaveBeenCalledOnce();
    expect(secondary).not.toHaveBeenCalled();
  });
});

describe('simulated packet-loss latency benchmark', () => {
  it('improves p99 query latency >30% compared with non-hedged sequential retry', async () => {
    // Deterministic packet loss: 1 in 5 primary requests hangs until 110ms,
    // then fails. Healthy secondary responds in 4ms. This measures actual
    // elapsed latencies locally; no RPC nodes or chain funds are involved.
    const count = 30;
    let primaryCalls = 0;
    const primary = async () => {
      const n = primaryCalls++;
      if (n % 5 === 0) {
        await sleep(110);
        throw new Error('packet loss');
      }
      await sleep(2);
      return 'primary';
    };
    const backup = async () => { await sleep(4); return 'backup'; };
    const connection = pool({
      'https://a.test': { getAccount: primary },
      'https://b.test': { getAccount: backup },
    }, {
      initialHedgeDelayMs: 17,
      minHedgeDelayMs: 12,
      maxHedgeDelayMs: 40,
      backoffBaseMs: 10,
    });

    // Compare a caller without speculative retries using the same failure
    // distribution. Avoid relying on parallel ordering for deterministic loss.
    const samplesSequential: number[] = [];
    const samplesHedged: number[] = [];
    for (let i = 0; i < count; i++) {
      const seqStart = performance.now();
      if (i % 5 === 0) {
        await sleep(110);
        await backup();
      } else {
        await sleep(2);
      }
      samplesSequential.push(performance.now() - seqStart);
    }
    const queries = Array.from({ length: count }, async () => {
      const start = performance.now();
      await connection.server.getAccount('GTEST');
      return performance.now() - start;
    });
    samplesHedged.push(...await Promise.all(queries));

    const p99 = (samples: number[]) => {
      const ordered = [...samples].sort((a, b) => a - b);
      return ordered[Math.ceil(ordered.length * 0.99) - 1];
    };
    const baseline = p99(samplesSequential);
    const hedged = p99(samplesHedged);
    expect(hedged).toBeLessThan(baseline * 0.7);
    expect(connection.getHealth().length).toBe(2);
  });
});
