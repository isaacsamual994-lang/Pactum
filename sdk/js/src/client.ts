/**
 * PactumClient — the primary integration surface for the @pactum/sdk.
 *
 * All Soroban RPC plumbing (XDR encoding/decoding, transaction building,
 * simulation, assembly, signing, and submission) is handled internally so
 * that callers only need to provide typed parameters.
 *
 * Deployed contract address (testnet):
 * CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E
 */
import { Contract, Keypair, rpc, scValToNative } from '@stellar/stellar-sdk';
import { DEFAULT_CONTRACT_ID, resolveNetwork } from './networks';
import { SorobanRpcPool, type RpcNodeHealth } from './rpcPool';
import { invokeContract, queryContract, type TxOptions } from './transaction';
import {
  encodeAddress,
  encodeAddressVec,
  encodeBytes32,
  encodeCommitmentStatus,
  encodeOptionAddress,
  encodeOptionU32,
  encodeU32,
  encodeU64,
  decodeCommitment,
  decodeReputation,
} from './xdr';
import type {
  AttestParams,
  Commitment,
  CommitmentStatus,
  CreateCommitmentParams,
  DisputeParams,
  PactumClientConfig,
  Reputation,
  ResolveDisputeParams,
} from './types';
import {
  PactumEventType,
  ContractEventMap,
  EventCallback,
  RawSorobanEvent,
  decodeSorobanEvent,
} from './events';

export class PactumClient {
  private readonly opts: TxOptions;
  private readonly rpcPool: SorobanRpcPool;
  private listeners: Map<PactumEventType, Set<EventCallback<any>>> = new Map();

  /**
   * Constructs a PactumClient connected to the specified network.
   *
   * @example
   * const client = new PactumClient({ network: 'testnet' });
   */
  constructor(config: PactumClientConfig = { network: 'testnet' }) {
    const targetNetwork = config?.network || 'testnet';
    const { rpcUrls, networkPassphrase } = resolveNetwork(
      targetNetwork,
      config?.rpcUrl,
      config?.networkPassphrase,
      config?.rpcUrls,
    );

    const contractId = config?.contractId ?? DEFAULT_CONTRACT_ID;

    this.rpcPool = new SorobanRpcPool(rpcUrls, config?.rpcPool);

    this.opts = {
      rpcServer: this.rpcPool.server,
      contract: new Contract(contractId),
      networkPassphrase,
    };
  }

  /** Read-only diagnostic snapshot of health and latency for configured RPC nodes. */
  public getRpcHealth(): RpcNodeHealth[] {
    return this.rpcPool.getHealth();
  }

  // ─── Event Listener Methods ───────────────────────────────────────────────

  /**
   * Registers a strongly typed event listener for contract events.
   * TypeScript strictly enforces that the callback payload matches the specified eventType.
   *
   * @param eventType Event type to listen for ('created' | 'attested' | 'disputed' | 'resolved')
   * @param callback Callback function receiving the strongly typed event payload
   * @returns Unsubscribe cleanup function
   */
  public on<K extends PactumEventType>(eventType: K, callback: EventCallback<K>): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);

    return () => {
      this.off(eventType, callback);
    };
  }

  /**
   * Unsubscribes a callback from a specific event type.
   */
  public off<K extends PactumEventType>(eventType: K, callback: EventCallback<K>): void {
    const callbackSet = this.listeners.get(eventType);
    if (callbackSet) {
      callbackSet.delete(callback);
    }
  }

  /**
   * Manually emits a typed event to all registered listeners.
   */
  public emit<K extends PactumEventType>(
    eventType: K,
    payload: ContractEventMap[K],
    rawEvent?: RawSorobanEvent,
  ): void {
    const callbackSet = this.listeners.get(eventType);
    if (callbackSet) {
      callbackSet.forEach((cb) => {
        try {
          cb(payload, rawEvent);
        } catch (error) {
          console.error(`[PactumClient] Error in '${eventType}' event callback:`, error);
        }
      });
    }
  }

  /**
   * Decodes a raw Soroban XDR / RPC event and dispatches it to registered typed listeners.
   *
   * @param rawEvent Raw Soroban event object containing topics and values
   * @returns True if decoded and dispatched, false otherwise
   */
  public handleRawEvent(rawEvent: RawSorobanEvent): boolean {
    const decoded = decodeSorobanEvent(rawEvent);
    if (!decoded) {
      return false;
    }

    this.emit(decoded.type, decoded.payload, rawEvent);
    return true;
  }

  /**
   * Removes all registered event listeners.
   */
  public removeAllListeners(eventType?: PactumEventType): void {
    if (eventType) {
      this.listeners.delete(eventType);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Returns the count of registered listeners for an event type.
   */
  public listenerCount(eventType: PactumEventType): number {
    return this.listeners.get(eventType)?.size || 0;
  }

  // ─── Write methods ──────────────────────────────────────────────────────────

  /**
   * Creates and registers a new commitment on-chain.
   *
   * @returns The unique commitment ID assigned by the contract.
   */
  async createCommitment(params: CreateCommitmentParams): Promise<bigint> {
    const attestors = params.attestors ?? [];
    const threshold = params.threshold ?? 0;

    const keypair = Keypair.fromSecret(params.issuerSecret);
    if (keypair.publicKey() !== params.issuer) {
      throw new Error('PactumClient.createCommitment: issuerSecret does not match issuer address.');
    }

    // resolver_address is required on-chain but has no on-chain default. Never fall back to
    // issuer/counterparty here: resolve_dispute's only guard is `caller == resolverAddress`, so
    // that would let a party unilaterally resolve their own dispute. The registry's current
    // arbitrator is the standard, no-custom-resolver choice -- it routes disputes through
    // committee majority vote instead of single-delegate resolution. See CreateCommitmentParams.
    const resolverAddress = params.resolverAddress ?? (await this.getArbitrator());

    const txHash = await invokeContract(this.opts, params.issuerSecret, 'create_commitment', [
      encodeAddress(params.issuer),
      encodeAddress(params.counterparty),
      encodeBytes32(params.termsHash),
      encodeU64(params.dueAt),
      encodeAddress(resolverAddress),
      encodeOptionAddress(params.oracle),
      encodeOptionU32(params.schemaId),
      encodeAddressVec(attestors),
      encodeU32(threshold),
    ]);

    const pollResult = await this.opts.rpcServer.getTransaction(txHash);
    if (
      pollResult.status === rpc.Api.GetTransactionStatus.SUCCESS &&
      'returnValue' in pollResult &&
      pollResult.returnValue != null
    ) {
      return BigInt(scValToNative(pollResult.returnValue));
    }

    throw new Error(
      `PactumClient.createCommitment: transaction succeeded (${txHash}) but return value could not be read.`,
    );
  }

  /**
   * Attests to the outcome of a commitment.
   *
   * @returns The transaction hash.
   */
  async attest(params: AttestParams): Promise<string> {
    return invokeContract(this.opts, params.callerSecret, 'attest', [
      encodeAddress(params.caller),
      encodeU64(params.id),
      encodeCommitmentStatus(params.outcome),
    ]);
  }

  /**
   * Raises a dispute on an attested commitment within the 7-day dispute window.
   *
   * @returns The transaction hash.
   */
  async dispute(params: DisputeParams): Promise<string> {
    return invokeContract(this.opts, params.callerSecret, 'dispute', [
      encodeAddress(params.caller),
      encodeU64(params.id),
    ]);
  }

  /**
   * Resolves a disputed commitment to a final outcome (arbitrator only).
   *
   * @returns The transaction hash.
   */
  async resolveDispute(params: ResolveDisputeParams): Promise<string> {
    return invokeContract(this.opts, params.arbitratorSecret, 'resolve_dispute', [
      encodeAddress(params.arbitrator),
      encodeU64(params.id),
      encodeCommitmentStatus(params.finalOutcome),
    ]);
  }

  // ─── Read methods ───────────────────────────────────────────────────────────

  /**
   * Retrieves a commitment by its unique ID.
   */
  async getCommitment(id: bigint): Promise<Commitment> {
    const stubPublicKey = this.opts.contract.address().toString();
    const val = await queryContract(this.opts, stubPublicKey, 'get_commitment', [encodeU64(id)]);
    return decodeCommitment(val);
  }

  /**
   * Returns true if the commitment is still Pending and its due date has passed.
   */
  async isOverdue(id: bigint): Promise<boolean> {
    const stubPublicKey = this.opts.contract.address().toString();
    const val = await queryContract(this.opts, stubPublicKey, 'is_overdue', [encodeU64(id)]);
    return Boolean(scValToNative(val));
  }

  /**
   * Retrieves the aggregate reputation for a given address.
   */
  async getReputation(address: string): Promise<Reputation> {
    const stubPublicKey = this.opts.contract.address().toString();
    const val = await queryContract(this.opts, stubPublicKey, 'get_reputation', [
      encodeAddress(address),
    ]);
    return decodeReputation(val);
  }

  /**
   * Retrieves the designated arbitrator address from the contract.
   *
   * Returns the first member of the arbitrator set. Prefer {@link getArbitrators}
   * when the committee can have more than one member.
   *
   * @example
   * const arb = await client.getArbitrator();
   */
  async getArbitrator(): Promise<string> {
    const stubPublicKey = this.opts.contract.address().toString();
    const val = await queryContract(this.opts, stubPublicKey, 'get_arbitrator', []);
    return String(scValToNative(val));
  }

  /**
   * Retrieves the full set of designated arbitrators.
   *
   * Disputes on committee-routed commitments are settled by a majority vote of
   * this set rather than by a single point of trust.
   *
   * @example
   * const arbitrators = await client.getArbitrators();
   */
  async getArbitrators(): Promise<string[]> {
    const stubPublicKey = this.opts.contract.address().toString();
    const val = await queryContract(this.opts, stubPublicKey, 'get_arbitrators', []);
    return scValToNative(val) as string[];
  }

  // ─── Type re-exports for convenience ────────────────────────────────────────

  /** CommitmentStatus enum values, accessible as PactumClient.Status. */
  static readonly Status = {
    Pending: 0 as CommitmentStatus,
    Fulfilled: 1 as CommitmentStatus,
    Late: 2 as CommitmentStatus,
    Breached: 3 as CommitmentStatus,
    Disputed: 4 as CommitmentStatus,
  } as const;
}
