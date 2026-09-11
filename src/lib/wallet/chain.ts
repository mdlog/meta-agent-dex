/** Somnia Shannon testnet, as the browser needs it for `wallet_addEthereumChain`. */
export const SOMNIA_SHANNON = {
  id: 50312,
  hexId: "0xc488",
  name: "Somnia Shannon Testnet",
  currency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: [process.env.NEXT_PUBLIC_SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network"],
  explorer: process.env.NEXT_PUBLIC_SOMNIA_EXPLORER ?? "https://shannon-explorer.somnia.network",
} as const;

export function txUrl(hash: string): string {
  return `${SOMNIA_SHANNON.explorer}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${SOMNIA_SHANNON.explorer}/address/${address}`;
}
