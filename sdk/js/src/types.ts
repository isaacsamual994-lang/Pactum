import type { RpcPoolOptions } from './rpcPool';

/**
 * Mirrors the on-chain CommitmentStatus enum defined in contracts/registry/src/commitments.rs.
 * Values match the Soroban u32 discriminant ordering.
 */
export enum CommitmentStatus {
  Pending = 0,
  Fulfilled = 1,
  Late = 2,
  Breached = 3,
  Disputed = 4,
}

/**
 * Mirrors the on-chain Commitment struct defined in contracts/registry/src/commitments.rs.
 */
export interface Commitment {
  /** Unique identifier for this commitment. */
  id: bigint;
  /** The party making the commitment. */
  issuer: string;
  /** The party the commitment is owed to. */
  counterparty: string;
  /** Hex-encoded 32-byte hash of the off-chain terms. */
  termsHash: string;
  /** Unix timestamp (seconds) when the commitment is due. */
  dueAt: bigint;
  /** Current lifecycle status. */
  status: CommitmentStatus;
  /** Unix timestamp (seconds) when the commitment was created. */
  createdAt: bigint;
  /** Unix timestamp (seconds) when attested, or null if not yet attested. */
  attestedAt: bigint | null;
  /** Assigned attestors for M-of-N voting (empty for simple commitments). */
  attestors: string[];
  /** Number of attestor votes required to resolve (0 for simple commitments). */
  threshold: number;
}

/**
 * Mirrors the on-chain Reputation struct defined in contracts/registry/src/reputation.rs.
 */
export interface Reputation {
  /** Number of fulfilled commitments. */
  fulfilledCount: number;
  /** Number of late commitments. */
  lateCount: number;
  /** Number of breached commitments. */
  breachedCount: number;
}

/** Network presets supported by the SDK. */
export type Network = 'mainnet' | 'testnet' | 'futurenet' | 'custom';

/** Configuration for PactumClient. */
export interface PactumClientConfig {
  /**
   * Network preset. Use 'custom' together with `rpcUrl` and `networkPassphrase`
   * to target a non-standard horizon.
   */
  network: Network;
  /**
   * Override the Soroban RPC endpoint. Required when `network` is 'custom'.
   * Optional for named presets (overrides the default URL for that network).
   */
  rpcUrl?: string;
  /**
   * Optional alternative Soroban RPC endpoints, all on the configured network.
   * When provided, this list takes precedence over rpcUrl.
   * Reads may be hedged across these endpoints; submissions are never replayed.
   */
  rpcUrls?: string[];
  /** Configure the optional multi-endpoint RPC pool. */
  rpcPool?: RpcPoolOptions;
  /**
   * Override the network passphrase. Required when `network` is 'custom'.
   * Optional for named presets.
   */
  networkPassphrase?: string;
  /**
   * Deployed contract address.
   * Defaults to the canonical testnet deployment:
   * CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E
   */
  contractId?: string;
}

/** Parameters for createCommitment. */
export interface CreateCommitmentParams {
  /** Address of the issuer (must sign the transaction). */
  issuer: string;
  /** Secret key of the issuer used to sign the transaction. */
  issuerSecret: string;
  /** Address of the counterparty. */
  counterparty: string;
  /** Hex-encoded 32-byte hash of the off-chain terms. */
  termsHash: string;
  /** Unix timestamp (seconds) when the commitment is due. */
  dueAt: bigint;
  /**
   * Address authorized to call `resolve_dispute` for this commitment. Required on-chain, with no
   * safe default: naming `issuer`/`counterparty` here would let a party unilaterally resolve their
   * own dispute (`resolve_dispute`'s only check is `caller == resolverAddress`). Omit this to
   * fall back to the registry's current arbitrator (`getArbitrator()`), which routes disputes
   * through committee majority vote instead of single-delegate resolution -- the standard,
   * no-custom-resolver behavior.
   */
  resolverAddress?: string;
  /**
   * Address additionally authorized to call `attest` for this commitment (alongside issuer and
   * counterparty), for automated/oracle-driven attestation. Omit for the default two-party flow.
   */
  oracle?: string;
  /**
   * Off-chain terms-template identifier echoed in the `commitment_created` event; purely
   * descriptive metadata, never read by the contract. Omit for freeform/untemplated terms.
   */
  schemaId?: number;
  /**
   * Assigned attestors for M-of-N voting. Omit or pass an empty array for
   * simple (single-party) commitments.
   */
  attestors?: string[];
  /**
   * Vote threshold for M-of-N (0 for simple commitments, 1-N for M-of-N).
   * Must be 0 when attestors is empty; between 1 and attestors.length otherwise.
   */
  threshold?: number;
}

/** Parameters for attest. */
export interface AttestParams {
  /** Address of the attesting party (issuer or counterparty). */
  caller: string;
  /** Secret key of the caller used to sign the transaction. */
  callerSecret: string;
  /** ID of the commitment to attest. */
  id: bigint;
  /** Outcome to attest (Fulfilled, Late, or Breached). */
  outcome: CommitmentStatus;
}

/** Parameters for dispute. */
export interface DisputeParams {
  /** Address of the disputing party (issuer or counterparty). */
  caller: string;
  /** Secret key of the caller used to sign the transaction. */
  callerSecret: string;
  /** ID of the commitment to dispute. */
  id: bigint;
}

/** Parameters for resolveDispute. */
export interface ResolveDisputeParams {
  /** Address of the designated arbitrator. */
  arbitrator: string;
  /** Secret key of the arbitrator used to sign the transaction. */
  arbitratorSecret: string;
  /** ID of the disputed commitment. */
  id: bigint;
  /** Final outcome (Fulfilled, Late, or Breached). */
  finalOutcome: CommitmentStatus;
}
