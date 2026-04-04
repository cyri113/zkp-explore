// services/alchemy/networkMap.ts
import { Network } from '@alch/alchemy-sdk';

const NETWORK_MAP: Record<string, Network> = {
  'mainnet': Network.ETH_MAINNET,
  'eth-mainnet': Network.ETH_MAINNET,
  'goerli': Network.ETH_GOERLI,
};

export function resolveNetwork(network: string): Network {
  const key = network.toLowerCase();
  const resolved = NETWORK_MAP[key];
  if (!resolved) {
    throw new Error(`Unsupported network: ${network}. Supported networks: ${Object.keys(NETWORK_MAP).join(', ')}`);
  }
  return resolved;
}