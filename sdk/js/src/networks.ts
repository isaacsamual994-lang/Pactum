import { Networks } from '@stellar/stellar-sdk';
import type { Network } from './types.js';

/** Canonical Pactum contract address on testnet. */
export const DEFAULT_CONTRACT_ID = 'CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E';

interface NetworkPreset {
  rpcUrl: string;
  networkPassphrase: string;
}

const PRESETS: Record<Exclude<Network, 'custom'>, NetworkPreset> = {
  mainnet: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: Networks.PUBLIC,
  },
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: Networks.FUTURENET,
  },
};

export interface ResolvedNetwork {
  rpcUrl: string;
  rpcUrls: string[];
  networkPassphrase: string;
}

/**
 * Resolves the RPC URL and network passphrase from user-supplied config.
 * Explicit values always override preset defaults.
 * Defaults to 'testnet' if network is not explicitly provided.
 */
export function resolveNetwork(
  network: Network = 'testnet',
  rpcUrl?: string,
  networkPassphrase?: string,
  rpcUrls?: string[],
): ResolvedNetwork {
  const targetNetwork = network || 'testnet';
  if (rpcUrls !== undefined && (!Array.isArray(rpcUrls) || rpcUrls.length === 0)) {
    throw new Error('PactumClient: rpcUrls must be a nonempty array when provided.');
  }

  const firstUrl = rpcUrls?.[0] ?? rpcUrl;
  if (targetNetwork === 'custom') {
    if (!firstUrl || !networkPassphrase) {
      throw new Error(
        "PactumClient: 'rpcUrl' or 'rpcUrls', and 'networkPassphrase' are required when network is 'custom'.",
      );
    }
    return { rpcUrl: firstUrl, rpcUrls: rpcUrls ?? [firstUrl], networkPassphrase };
  }

  const preset = PRESETS[targetNetwork] || PRESETS.testnet;
  const url = firstUrl ?? preset.rpcUrl;
  return {
    rpcUrl: url,
    rpcUrls: rpcUrls ?? [url],
    networkPassphrase: networkPassphrase ?? preset.networkPassphrase,
  };
}
