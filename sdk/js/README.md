# Pactum JavaScript SDK

The JavaScript SDK provides typed read and write methods for Pactum commitments on Soroban.

## Soroban RPC failover

By default, an SDK client uses one endpoint from its network preset, as before:

    const client = new PactumClient({ network: 'testnet' });

For resilient reads, configure multiple RPC endpoints belonging to the SAME Stellar network:

    import { PactumClient } from '@pactum/sdk';

    const client = new PactumClient({
      network: 'testnet',
      rpcUrls: [
        'https://soroban-testnet.stellar.org',
        'https://your-backup-testnet-rpc.example',
      ],
      rpcPool: {
        initialHedgeDelayMs: 180,
        minHedgeDelayMs: 40,
        maxHedgeDelayMs: 1500,
        requestTimeoutMs: 12000,
        backoffBaseMs: 250,
        maxBackoffMs: 10000,
        ewmaAlpha: 0.25,
      },
    });

    const commitment = await client.getCommitment(10n);
    console.log(commitment);

The existing single rpcUrl override is still supported. If rpcUrls is supplied,
the ordered array takes precedence; an empty array is invalid. Custom networks
require a passphrase and either rpcUrl or a nonempty rpcUrls array.

### Routing and safety

- Each endpoint receives independently smoothed latency, success-rate and HTTP
  429/rate-limit scores. Failing nodes cool down with capped exponential
  backoff. Healthy nodes are preferred for subsequent calls.
- For **idempotent RPC reads and simulations only**, a speculative request to a
  backup node may start if the first endpoint has not answered by its observed
  rolling p95 latency (up to 64 samples). Before observing samples, the
  configured initial delay is used. Only two endpoint requests may be in flight
  at once for a single read; further endpoints are tried on failure.
- Individual RPC attempts are time-bounded. When all endpoints fail, the last
  underlying error is surfaced; the pool does not fabricate a successful
  response.
- **Signed sendTransaction is never automatically hedged or retried.** On a
  timeout or transport error, a transaction may already have been accepted.
  **Reconcile its hash/status before any manual resubmission.** Read-only
  simulation/get-account/get-transaction calls can fail over; submissions
  cannot. This distinction avoids accidental duplicate payments.
- The underlying SDK does not expose cancellation for every method; a late
  response from a losing read is ignored for its caller, though the original
  request may complete in the background.

Inspect node health without making additional network calls:

    const nodes = client.getRpcHealth();
    // nodes: [{ url, latencyEwmaMs, successRateEwma,
    //           rateLimitRateEwma, consecutiveFailures,
    //           coolingUntil, observedP95Ms }, ...]

Do not mix mainnet/testnet/futurenet endpoints in one pool; all URLs must target
the configured network. This pool optimizes request availability and does not
independently verify consensus or proof correctness.

### Testing

Run from sdk/js:

    npm ci
    npm run ci
    npx tsc --noEmit

The new tests/rpcPool.test.ts covers single and multiple endpoint configuration,
read-only p95 hedging, health scores, 429 cooldown, read failover and timeout,
third-node fallback, and the prohibition against automatic signed-transaction
resubmission. Its synthetic packet-loss test measures p99 read latency against
non-hedged sequential retry and requires at least a 30% improvement **in that
synthetic test**. It does not claim a 30% gain against arbitrary live traffic.
