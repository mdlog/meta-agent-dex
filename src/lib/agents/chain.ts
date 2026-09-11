/**
 * The server's hands on chain for Meta-Agent DEX.
 *
 * SERVER ONLY. This module reads `DEPLOYER_PRIVATE_KEY` and signs with it, so
 * it must never be reachable from a client component — importing it into one
 * would bundle the import graph for the browser and the key read would be the
 * least of the problems. Everything here is called from route handlers running
 * with `runtime = "nodejs"`.
 *
 * What it owns: deploying one `BotVault` + one `BotNavOracle` per agent
 * session, opening both, minting the second-layer DreamDEX Event Contract whose
 * settlement source is that oracle, and closing the loop afterwards. Reads that
 * decide money — NAV, the oracle's frozen answer — come from chain head. The
 * committee's verdict comes from the indexer, because resolution is an event
 * and there is no chain read that reports "voided" without one.
 *
 * The recipe below is measured against live Shannon, not derived from docs; the
 * comments say what was measured where it matters.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseAbiParameters,
  parseEventLogs,
  type Address,
  type Hex,
  erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import {
  binaryModuleCreationEventAbi,
  botNavOracleAbi,
  botVaultAbi,
  marketCreationAbi,
  moduleReadsAbi,
  oracleHubCostAbi,
  outcomeTokenReadsAbi,
} from "./abi";

// ---------------------------------------------------------------------------
// Addresses and constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.SOMNIA_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";

// `SomniaMarketsAddresses` types every field optional, so the `??` is a type
// obligation rather than a doubt about the value. The fallbacks are the
// addresses our own Shannon transactions were mined against.
const COLLATERAL: Address = SOMNIA_TESTNET_ADDRESSES.collateral ?? "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const BINARY_MODULE: Address = SOMNIA_TESTNET_ADDRESSES.binaryModule ?? "0x3ecC694Cef705358864a646142ac17A90E29e388";
const ORACLE_HUB: Address = SOMNIA_TESTNET_ADDRESSES.oracleHub ?? "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b";

/**
 * The ERC-6909 singleton every binary market on this deployment issues outcome
 * ids against — checked by reading `outcomeToken()` off three unrelated market
 * clones (ids 0x1, 0x1580a, 0x15849, three distinct clone addresses, one token).
 * The SDK does not export it, so the vault is handed it at construction: without
 * that grant `module.redeem` reverts `InsufficientPermission()` and a winning
 * session silently never converts back into NAV.
 */
const OUTCOME_TOKEN: Address =
  (process.env.SOMNIA_OUTCOME_TOKEN as Address | undefined) ?? "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";

/**
 * Our own operator and BINARY_V1 venue, registered in
 * `scripts/spike/01-operator-venue.ts` with policy/signer zeroed. Minting
 * through someone else's venue would mean a demo that dies the moment they
 * close creation.
 */
const OPERATOR_ID = Number(process.env.AGENT_OPERATOR_ID ?? 20);
const VENUE_ID: Hex =
  (process.env.AGENT_VENUE_ID as Hex | undefined) ??
  "0xa3c034a0398f2cd3465cee88fec2489b78fe26933af4d394d6c87fc4cf00fa77";

/**
 * Measured, not guessed. A one-source mint costs 21.9M gas; each extra JSON
 * source adds roughly 0.35M, and seven sources at a 26M ceiling reverted with
 * EMPTY revert data after burning 24.0M — an inner call starved of its 63/64
 * allowance, not a rejected argument. Replaying the identical calldata at 60M
 * succeeds. Somnia's block limit is 15 BILLION gas, so headroom is free and
 * unused gas is refunded; being stingy here only buys an unexplained revert.
 */
const MINT_GAS = 80_000_000n;

/**
 * Every voided third-party sample we decoded had `resolutionTime == expiry`,
 * giving the committee no window between the last tradeable second and the read.
 * A buffer is not optional.
 */
const MIN_RESOLUTION_BUFFER_SEC = 60;

/**
 * Six JSON sources plus one Contract source.
 *
 * Quoted against the live hub: 0.576 STT for a definition with no sources at
 * all, +0.12 STT per JSON source, and +0.00 for a contract source — 0, 1 and 3
 * contract sources all price identically. Nobody is paid to service a contract
 * source, and it shows: 7 of 10 live samples on that tier voided, against 122
 * of 20,617 on the 6-JSON tier DreamDEX's own production markets use.
 *
 * So the JSON sources are what actually gets this market resolved, and the free
 * contract source rides along as the on-chain attestation that the answer came
 * from our oracle rather than from a URL we control.
 */
const JSON_SOURCE_COUNT = 6;

/** `QuestionSourceType` (OracleTypes.sol): 0 Website · 1 JSON · 2 Contract. */
const SOURCE_TYPE_JSON = 1;
const SOURCE_TYPE_CONTRACT = 2;

/** `AnswerType` (OracleTypes.sol): 0 Numeric · 1 Discrete. */
const ANSWER_TYPE_NUMERIC = 0;

/**
 * 1 = YES (NAV rose), 2 = NO, registered as the degenerate intervals [1,1]
 * and [2,2].
 *
 * Zero is deliberately outside both. `BotNavOracle.outcomeValue()` returns 0
 * until it is finalized, so a session nobody froze lands outside every valid
 * interval and VOIDS — refunding both sides — instead of being read as "the
 * agent lost". Encoding NO as 0 would have made those two states the same
 * number to the committee, and a minted market's answer registration can never
 * be restated.
 *
 * THE ORDER OF THIS ARRAY IS THE PAYOUT WIRING, not decoration. DreamDEX's
 * winning outcome is the INDEX of the interval the answer landed in — measured
 * on our own settled market 0x…1580a, which registered [[0,0],[1,1]], read 1
 * from its oracle and finalized with `winningOutcome: 1`, payout vector
 * [0, 1e7]. Outcome index 0 is the market's YES/Up leg (`markets()` returns
 * yesId before noId; `outcomeFromIndex` maps 0 → "up").
 *
 * So YES must be registered FIRST: answer 1 (NAV rose) lands in interval index
 * 0, which is the Up leg, and a retail buyer of Up wins exactly when the agent
 * profits. Registering NO first would invert every market on the platform while
 * looking perfectly reasonable in review — the legs are wired here, once, and
 * nothing downstream re-translates them.
 *
 * The ordering stays ascending, which is the only ordering any live sample uses;
 * a descending pair could not be tested without minting, because `eth_call`
 * reverts on this create even for the parameter set that mints successfully.
 */
const OUTCOME_YES = 1n;
const OUTCOME_NO = 2n;

/**
 * Outcome index → the oracle answer that index pays on. Index 0 (Up/YES leg)
 * pays on {@link OUTCOME_YES}, so no translation is needed anywhere else.
 */
const OUTCOME_INDEX_TO_ANSWER: readonly [1, 2] = [1, 2];

/**
 * Committee shape, copied from the decoded production creations. `minAgreement`
 * is the tier the 6-JSON production markets are registered at; the
 * subcommittee is 3 members voting to a threshold of 2.
 */
const MIN_AGREEMENT = 4n;
const SUBCOMMITTEE_SIZE = 3n;
const SUBCOMMITTEE_THRESHOLD = 2n;

/** The pool's order grid. Same tick/lot/minimum as every live BinaryPool. */
const BOOK_PARAMS = { tickSize: 1000n, minQuantity: 1000n, lotSize: 1000n } as const;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function makeClients() {
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY is not set — the server cannot deploy vaults, open sessions or mint meta-markets without it.",
    );
  }
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  return {
    account,
    publicClient: createPublicClient({ chain: somniaShannon, transport: http(RPC_URL) }),
    wallet: createWalletClient({ account, chain: somniaShannon, transport: http(RPC_URL) }),
  };
}

type Clients = ReturnType<typeof makeClients>;

/**
 * Pinned to `globalThis` for the same reason the RPC client in
 * `dreamdex/receipt.ts` is: Next's dev-mode module reloading would otherwise
 * leak one transport — and one write queue — per edit.
 */
const globalRef = globalThis as typeof globalThis & {
  __metaAgentChain?: Clients;
  __metaAgentWriteQueue?: Promise<unknown>;
};

function clients(): Clients {
  globalRef.__metaAgentChain ??= makeClients();
  return globalRef.__metaAgentChain;
}

/**
 * Every write goes through one queue.
 *
 * There is a single deployer key and several routes that can fire at once — two
 * operators opening sessions in the same second, a mint racing a finalize. viem
 * fetches the pending nonce per transaction, so two concurrent writes take the
 * same nonce and the second one is dropped by the node with no error the caller
 * can see. Serialising also keeps two 26M-gas mints out of the same block.
 */
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const previous = globalRef.__metaAgentWriteQueue ?? Promise.resolve();
  // Both branches run `run`: a failed predecessor must not poison the queue.
  const next = previous.then(run, run);
  globalRef.__metaAgentWriteQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function confirm(hash: Hex, what: string) {
  const receipt = await clients().publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${what} reverted on chain (tx ${hash})`);
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// Compiled bytecode
// ---------------------------------------------------------------------------

interface CompiledContract {
  bin?: string;
}

interface CombinedJson {
  contracts?: Record<string, CompiledContract>;
}

/**
 * solc `--combined-json abi,bin` output. Regenerate with:
 *
 *   solc --combined-json abi,bin --optimize --via-ir \
 *        contracts/BotVault.sol contracts/BotNavOracle.sol > contracts/out/contracts.json
 *
 * `--via-ir` is required, not cosmetic: `BotVault.redeemAll` destructures a
 * 14-field return and the legacy pipeline fails it with "stack too deep".
 */
const ARTIFACT_PATH = process.env.AGENT_CONTRACT_ARTIFACTS ?? "contracts/out/contracts.json";

let artifacts: CombinedJson | null = null;

/** Creation bytecode for one `path.sol:Name` key, loaded once per process. */
function bytecode(qualifiedName: string): Hex {
  if (!artifacts) {
    const file = resolve(ARTIFACT_PATH);
    try {
      artifacts = JSON.parse(readFileSync(file, "utf8")) as CombinedJson;
    } catch (e) {
      throw new Error(
        `Cannot read compiled contracts from ${file} (${(e as Error).message}). ` +
          "Recompile with solc --combined-json abi,bin --optimize --via-ir, or point AGENT_CONTRACT_ARTIFACTS at the output.",
      );
    }
  }
  const bin = artifacts.contracts?.[qualifiedName]?.bin;
  if (!bin || !/^[0-9a-fA-F]+$/.test(bin)) {
    throw new Error(`${qualifiedName} carries no creation bytecode in ${ARTIFACT_PATH}.`);
  }
  return `0x${bin}`;
}

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

// Addresses and ids reach this module as `string` — they come out of SQLite,
// where `Agent.vaultAddress` and friends are plain text. Validating here rather
// than casting means a truncated row fails on this line with the field name,
// instead of as an opaque ABI encode error three calls deeper.

function mustAddress(value: string, field: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${field} is not an address: ${JSON.stringify(value)}`);
  }
  return value as Address;
}

function mustBytes32(value: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${field} is not a 32-byte hex value: ${JSON.stringify(value)}`);
  }
  return value as Hex;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Deploy one agent's `BotVault`.
 *
 * `owner` moves capital and may never trade; `operator` is the runner's hot key
 * and may only call `trade`. Sent as a raw creation transaction rather than
 * through `deployContract` so the constructor arguments are spelled out here —
 * their order is the whole separation of powers and is worth reading in place.
 */
export async function deployVault(input: {
  owner: string;
  operator: string;
}): Promise<{ address: string; txHash: string }> {
  const owner = mustAddress(input.owner, "owner");
  const operator = mustAddress(input.operator, "operator");

  return serialize(async () => {
    const { wallet } = clients();
    const txHash = await wallet.sendTransaction({
      data: concatHex([
        bytecode("contracts/BotVault.sol:BotVault"),
        encodeAbiParameters(parseAbiParameters("address, address, address, address, address"), [
          COLLATERAL,
          BINARY_MODULE,
          OUTCOME_TOKEN,
          owner,
          operator,
        ]),
      ]),
    });
    const receipt = await confirm(txHash, "BotVault deploy");
    if (!receipt.contractAddress) {
      throw new Error(`BotVault deploy mined without a contract address (tx ${txHash})`);
    }
    return { address: receipt.contractAddress.toLowerCase(), txHash };
  });
}

/**
 * Move collateral into a vault and book it as `protocolCash`.
 *
 * This is the ONLY way NAV ever rises without a DreamDEX call, and it is gated
 * to the vault's owner and to the gaps between sessions — a deposit mid-session
 * would let an operator who had bet against their own agent buy the answer. The
 * keeper owns the demo agents, so it is also the depositor for them.
 *
 * The collateral's `faucet` is permissionless and uncapped in frequency, so
 * topping the keeper up costs nothing but gas and needs no external faucet page.
 */
export async function fundVault(input: { vault: string; amount: bigint }): Promise<{ txHash: string }> {
  const vault = mustAddress(input.vault, "vault");
  if (input.amount <= 0n) throw new Error("fundVault amount must be positive");

  return serialize(async () => {
    const { publicClient, wallet } = clients();
    const held = (await publicClient.readContract({
      address: COLLATERAL,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet.account.address],
    })) as bigint;

    if (held < input.amount) {
      // 10,000e6 is the per-call cap; there is no cooldown, so loop rather than fail.
      const short = input.amount - held;
      const calls = Number((short + FAUCET_CAP - 1n) / FAUCET_CAP);
      for (let i = 0; i < calls; i += 1) {
        await confirm(
          await wallet.writeContract({ address: COLLATERAL, abi: collateralFaucetAbi, functionName: "faucet", args: [FAUCET_CAP] }),
          "collateral faucet",
        );
      }
    }

    await confirm(
      await wallet.writeContract({ address: COLLATERAL, abi: erc20Abi, functionName: "approve", args: [vault, input.amount] }),
      "collateral approve",
    );
    const txHash = await wallet.writeContract({
      address: vault,
      abi: botVaultAbi,
      functionName: "deposit",
      args: [input.amount],
    });
    await confirm(txHash, "vault deposit");
    return { txHash };
  });
}

/** Per-call cap on the test collateral's public faucet. There is no cooldown. */
const FAUCET_CAP = 10_000_000_000n;

const collateralFaucetAbi = [
  { type: "function", name: "faucet", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

/**
 * Deploy the `BotNavOracle` for one session.
 *
 * One per session, never reused: the answer is frozen once and a shared oracle
 * would mean session N+1 restating session N's result under a market that has
 * already paid out. The deployer becomes the keeper, which is only the right to
 * call `open()` — `finalize()` is permissionless.
 */
export async function deployOracle(input: {
  vault: string;
  closesAt: number;
  sessionNumber: number;
}): Promise<{ address: string; txHash: string }> {
  const vault = mustAddress(input.vault, "vault");

  return serialize(async () => {
    const { wallet } = clients();
    const txHash = await wallet.sendTransaction({
      data: concatHex([
        bytecode("contracts/BotNavOracle.sol:BotNavOracle"),
        encodeAbiParameters(parseAbiParameters("address, uint64, uint256"), [
          vault,
          BigInt(input.closesAt),
          BigInt(input.sessionNumber),
        ]),
      ]),
    });
    const receipt = await confirm(txHash, "BotNavOracle deploy");
    if (!receipt.contractAddress) {
      throw new Error(`BotNavOracle deploy mined without a contract address (tx ${txHash})`);
    }
    return { address: receipt.contractAddress.toLowerCase(), txHash };
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Open the vault's session.
 *
 * `endsAt` must outlive every market the agent will touch — the vault rejects a
 * trade whose market expires later — so it is chosen by the caller, not here.
 * The session number is read back from chain rather than incremented locally:
 * `agent_sessions` is UNIQUE on (agentId, sessionNumber), and a local counter
 * that drifts from the vault's writes a row that describes the wrong session.
 */
/**
 * Owner keys for vaults this server did not deploy, keyed by vault address.
 *
 * `openSession` and `deposit` are `onlyOwner`, and until now the only owner the
 * server could sign for was `DEPLOYER_PRIVATE_KEY` — so every agent's vault had
 * to be owned by the one wallet that deployed all of them, and the board showed
 * three agents whose contracts all traced to a single creator. An agent whose
 * owner is genuinely its own wallet is the point of registering by signature
 * (`POST /api/agents`), and this is what lets the keeper still drive one.
 *
 * The file is `.data/` and therefore gitignored, and it holds real keys — it is
 * the same trust boundary as `.data/demo-operators.json`, and no wider: an
 * owner key moves that vault's capital and cannot trade, which is the split
 * BotVault's modifiers already draw.
 */
const OWNER_KEYS_PATH = process.env.AGENT_OWNER_KEYS ?? ".data/agent-owners.json";

function ownerKeyFor(vault: Address): Hex | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(OWNER_KEYS_PATH), "utf8")) as Record<string, string>;
    const key = raw[vault.toLowerCase()];
    return key ? ((key.startsWith("0x") ? key : `0x${key}`) as Hex) : null;
  } catch {
    // No file is the ordinary case: every vault this server deployed is owned
    // by the deployer, and needs nothing here.
    return null;
  }
}

/**
 * The wallet entitled to call an `onlyOwner` function on this vault.
 *
 * Reads `owner()` rather than assuming, so a vault the deployer owns costs one
 * call and a vault it does not is refused with the address that does own it —
 * instead of a bare revert once per keeper pass.
 */
async function ownerWallet(vault: Address) {
  const { publicClient, wallet, account } = clients();
  const owner = (await publicClient.readContract({
    address: vault,
    abi: botVaultAbi,
    functionName: "owner",
  })) as Address;

  if (owner.toLowerCase() === account.address.toLowerCase()) return wallet;

  const key = ownerKeyFor(vault);
  if (key === null) {
    throw new Error(
      `Vault ${vault} is owned by ${owner}, and this server holds no key for it. ` +
        `Add it to ${OWNER_KEYS_PATH} keyed by the vault address, or let its owner open its sessions.`,
    );
  }
  const owned = privateKeyToAccount(key);
  if (owned.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`The key stored for vault ${vault} is ${owned.address}, but the vault is owned by ${owner}.`);
  }
  return createWalletClient({ account: owned, chain: somniaShannon, transport: http(RPC_URL) });
}

/**
 * Raise a vault to `target` if it is below it. Returns what was deposited.
 *
 * WHY THIS LIVES BESIDE `openVaultSession` AND NOT IN A SCRIPT. `deposit` is
 * `onlyOwner` and reverts `SessionIsOpen()`, so a vault is fundable only
 * between the session that just closed and the one about to open. The keeper
 * reopens roughly thirty seconds after it settles, and eleven agents settle at
 * eleven different times, so that window is seconds wide and moves. A scheduled
 * "settle, then fund" pass therefore cannot win: measured on 2026-09-09, three
 * consecutive passes funded two vaults apiece and left seven sitting at the
 * 10 tUSDC cash floor with `budget=0.00`, unable to place a single order for a
 * whole session. Doing it here makes the window an invariant instead of a race
 * — this runs inside the same call that opens the next session.
 *
 * A failure is deliberately not fatal to the caller. An agent that could not be
 * topped up should still get its session: trading on a thin vault is a worse
 * outcome than not trading at all, but not opening the session at all is worse
 * than both, and it would also stop the meta-market that session is measured by.
 */
export async function topUpVault(input: {
  vault: string;
  target: bigint;
}): Promise<{ deposited: bigint; txHash: string | null; note: string | null }> {
  const vault = mustAddress(input.vault, "vault");
  if (input.target <= 0n) return { deposited: 0n, txHash: null, note: null };

  return serialize(async () => {
    const { publicClient } = clients();
    const [nav, sessionOpen] = (await Promise.all([
      publicClient.readContract({ address: vault, abi: botVaultAbi, functionName: "nav" }),
      publicClient.readContract({ address: vault, abi: botVaultAbi, functionName: "sessionOpen" }),
    ])) as [bigint, boolean];

    // The guard the whole function exists to respect. Never broadcast a deposit
    // that the vault is going to revert.
    if (sessionOpen) return { deposited: 0n, txHash: null, note: "session still open" };
    if (nav >= input.target) return { deposited: 0n, txHash: null, note: null };

    const amount = input.target - nav;
    const wallet = await ownerWallet(vault);
    const owner = wallet.account!.address;
    const { account } = clients();

    const held = (await publicClient.readContract({
      address: COLLATERAL,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;

    if (held < amount) {
      // The deployer may mint what it needs; an independent owner may not. Its
      // balance is the visible evidence that it funds itself, and conjuring
      // collateral into it out of the faucet would erase exactly that.
      if (owner.toLowerCase() !== account.address.toLowerCase()) {
        return {
          deposited: 0n,
          txHash: null,
          note: `owner ${owner} holds ${held} of the ${amount} needed`,
        };
      }
      const short = amount - held;
      const calls = Number((short + FAUCET_CAP - 1n) / FAUCET_CAP);
      for (let i = 0; i < calls; i += 1) {
        await confirm(
          await wallet.writeContract({
            address: COLLATERAL, abi: collateralFaucetAbi, functionName: "faucet", args: [FAUCET_CAP],
          }),
          "collateral faucet",
        );
      }
    }

    await confirm(
      await wallet.writeContract({ address: COLLATERAL, abi: erc20Abi, functionName: "approve", args: [vault, amount] }),
      "collateral approve",
    );
    const txHash = await wallet.writeContract({
      address: vault, abi: botVaultAbi, functionName: "deposit", args: [amount],
    });
    await confirm(txHash, "vault deposit");
    return { deposited: amount, txHash, note: null };
  });
}

export async function openVaultSession(input: {
  vault: string;
  endsAt: number;
}): Promise<{ txHash: string; sessionNumber: number; navT0: string }> {
  const vault = mustAddress(input.vault, "vault");

  return serialize(async () => {
    const { publicClient } = clients();
    // `onlyOwner`, and the owner is no longer always the deployer.
    const wallet = await ownerWallet(vault);
    const txHash = await wallet.writeContract({
      address: vault,
      abi: botVaultAbi,
      functionName: "openSession",
      args: [BigInt(input.endsAt)],
    });
    await confirm(txHash, "openSession");

    const [sessionId, nav] = await Promise.all([
      publicClient.readContract({ address: vault, abi: botVaultAbi, functionName: "sessionId" }),
      publicClient.readContract({ address: vault, abi: botVaultAbi, functionName: "nav" }),
    ]);
    return { txHash, sessionNumber: Number(sessionId), navT0: nav.toString() };
  });
}

/**
 * Snapshot the opening NAV in the oracle.
 *
 * Must run AFTER the vault session is open and BEFORE the meta-market is
 * minted: navT0 is the baseline the whole second-layer bet is written against,
 * and taking it after people have started betting would let the baseline move
 * under them.
 */
export async function openOracle(input: { oracle: string }): Promise<{ txHash: string; navT0: string }> {
  const oracle = mustAddress(input.oracle, "oracle");

  return serialize(async () => {
    const { publicClient, wallet } = clients();
    const txHash = await wallet.writeContract({
      address: oracle,
      abi: botNavOracleAbi,
      functionName: "open",
    });
    await confirm(txHash, "oracle open");

    const navT0 = await publicClient.readContract({
      address: oracle,
      abi: botNavOracleAbi,
      functionName: "navT0",
    });
    return { txHash, navT0: navT0.toString() };
  });
}

/**
 * Convert every terminal position back into collateral. Permissionless on
 * chain, so the server calling it is a convenience rather than a trust
 * assumption — anyone can run it if we do not.
 *
 * Must precede {@link finalizeOracle}: NAV counts collateral, and an unredeemed
 * winning position is worth nothing to `protocolCash`.
 */
export async function redeemAll(input: { vault: string }): Promise<{ txHash: string }> {
  const vault = mustAddress(input.vault, "vault");

  return serialize(async () => {
    const txHash = await clients().wallet.writeContract({
      address: vault,
      abi: botVaultAbi,
      functionName: "redeemAll",
    });
    await confirm(txHash, "redeemAll");
    return { txHash };
  });
}

/** Flip the vault back to "no session", which is the only state it accepts deposits in. */
export async function closeVaultSession(input: { vault: string }): Promise<{ txHash: string }> {
  const vault = mustAddress(input.vault, "vault");

  return serialize(async () => {
    const txHash = await clients().wallet.writeContract({
      address: vault,
      abi: botVaultAbi,
      functionName: "closeSession",
    });
    await confirm(txHash, "closeSession");
    return { txHash };
  });
}

/**
 * Freeze the answer.
 *
 * Every committee member must read the same number, and `vault.nav()` keeps
 * moving until it is frozen. `finalize()` is a no-op once final rather than a
 * revert, so calling it twice is safe — which matters because it is also
 * permissionless and someone else may have got there first.
 */
export async function finalizeOracle(input: { oracle: string }): Promise<{ txHash: string }> {
  const oracle = mustAddress(input.oracle, "oracle");

  return serialize(async () => {
    const txHash = await clients().wallet.writeContract({
      address: oracle,
      abi: botNavOracleAbi,
      functionName: "finalize",
    });
    await confirm(txHash, "oracle finalize");
    return { txHash };
  });
}

// ---------------------------------------------------------------------------
// Minting the second-layer market
// ---------------------------------------------------------------------------

/**
 * The oracle's six JSON witnesses.
 *
 * Honest description of what these are: six reads of ONE HTTP mirror of one
 * on-chain number, not six independent sources. They do not add evidence. They
 * buy servicing — the hub prices JSON sources and therefore pays committee
 * members to fetch them, which is the difference between the 0.59% void rate
 * (122 of 20,617) DreamDEX's own production markets see and the 70% (7 of 10)
 * measured on the free contract-source tier. The urls differ only by a `v`
 * query parameter because the hub keys sources by exact url and collapses
 * duplicates.
 */
function jsonSources(oracle: Address, oracleUrlBase: string) {
  const base = oracleUrlBase.replace(/\/+$/, "");
  return Array.from({ length: JSON_SOURCE_COUNT }, (_, i) => ({
    sourceType: SOURCE_TYPE_JSON,
    // abi.encode(string url, string jsonPath, uint256 decimals) — the same
    // shape production uses for its Binance klines sources, where the path is
    // "[0][4]" and decimals 2. Ours reads one integer, so decimals is 0.
    params: encodeAbiParameters(parseAbiParameters("string, string, uint256"), [
      `${base}/api/oracle/session/${oracle}?v=${i + 1}`,
      // Dot/bracket notation, recovered from the production sources on tx
      // 0xa7c82825… ("[0][4]", "data[0][4]", "result.list[0][4]"). A bare key is
      // just the key. A wrong path fails at RESOLUTION, not at mint: the market
      // is created, takes bets, and then voids.
      "value",
      0n,
    ]),
  }));
}

/**
 * Build the question definition. Extracted because the SAME object must be
 * priced and then minted: `getSchedulingCost` is content-addressed over this
 * exact tuple, so quoting one definition and creating another underpays.
 */
function questionDefinition(input: {
  oracle: Address;
  agentName: string;
  sessionNumber: number;
  resolutionTime: number;
  oracleUrlBase: string;
}) {
  return {
    questionText: `Did agent ${input.agentName} finish session #${input.sessionNumber} with a higher NAV than it started (${input.oracle})?`,
    sources: [
      ...jsonSources(input.oracle, input.oracleUrlBase),
      {
        sourceType: SOURCE_TYPE_CONTRACT,
        // abi.encode(address target, string selector, string args, uint256 arg)
        params: encodeAbiParameters(parseAbiParameters("address, string, string, uint256"), [
          input.oracle,
          "outcomeValue()",
          "",
          0n,
        ]),
      },
    ],
    validAnswers: {
      answerType: ANSWER_TYPE_NUMERIC,
      discreteOutcomes: [],
      numericIntervals: [
        [OUTCOME_YES, OUTCOME_YES],
        [OUTCOME_NO, OUTCOME_NO],
      ],
      numericDecimals: 0n,
    },
    resolutionTime: BigInt(input.resolutionTime),
    minAgreement: MIN_AGREEMENT,
    subcommitteeSize: SUBCOMMITTEE_SIZE,
    subcommitteeThreshold: SUBCOMMITTEE_THRESHOLD,
  } as const;
}

/**
 * Mint the native DreamDEX Event Contract that retail bets on.
 *
 * `configHash` is the agent's declared strategy, hashed. It goes into the
 * market's `context` alongside the vault and the session number, so the terms
 * of the bet are recoverable from chain alone rather than from this database.
 */
export async function mintMetaMarket(input: {
  oracle: string;
  vault: string;
  agentName: string;
  sessionNumber: number;
  configHash: string;
  tradingStart: number;
  expiry: number;
  resolutionTime: number;
  /** Public origin the committee will fetch the oracle mirror from, e.g. `https://forecast-arena.mdloglabs.org`. */
  oracleUrlBase: string;
}): Promise<{ marketId: string; poolAddress: string; txHash: string }> {
  const oracle = mustAddress(input.oracle, "oracle");
  const vault = mustAddress(input.vault, "vault");
  const configHash = mustBytes32(input.configHash, "configHash");

  if (input.tradingStart >= input.expiry) {
    throw new Error(`tradingStart ${input.tradingStart} must precede expiry ${input.expiry}`);
  }
  if (input.resolutionTime < input.expiry + MIN_RESOLUTION_BUFFER_SEC) {
    throw new Error(
      `resolutionTime ${input.resolutionTime} must be at least ${MIN_RESOLUTION_BUFFER_SEC}s after expiry ${input.expiry} — ` +
        "a committee given no window between the last trade and the read is a market that voids.",
    );
  }
  if (!/^https?:\/\//.test(input.oracleUrlBase)) {
    throw new Error(`oracleUrlBase must be an absolute http(s) origin, got ${JSON.stringify(input.oracleUrlBase)}`);
  }

  const def = questionDefinition({
    oracle,
    agentName: input.agentName,
    sessionNumber: input.sessionNumber,
    resolutionTime: input.resolutionTime,
    oracleUrlBase: input.oracleUrlBase,
  });

  return serialize(async () => {
    const { publicClient, wallet } = clients();

    // Re-quoted per mint. The reserve derives from the hub's maxFeePerGas and
    // admins retune it; a hardcoded figure underpays the day they do, and the
    // surplus is refunded in-transaction so over-reading costs nothing.
    const [schedulingCost, resolveReserve] = await Promise.all([
      publicClient.readContract({
        address: ORACLE_HUB,
        abi: oracleHubCostAbi,
        functionName: "getSchedulingCost",
        args: [def],
      }),
      publicClient.readContract({
        address: ORACLE_HUB,
        abi: oracleHubCostAbi,
        functionName: "resolveReserve",
      }),
    ]);

    const txHash = await wallet.writeContract({
      address: BINARY_MODULE,
      abi: marketCreationAbi,
      functionName: "scheduleAndCreateMarket",
      args: [
        OPERATOR_ID,
        VENUE_ID,
        // Adapter and oracle are both the hub: the hub IS the one
        // governance-approved adapter, and our contract is a source inside the
        // question it schedules, never the market's oracle directly.
        ORACLE_HUB,
        def,
        {
          oracleQuestionId: 0n,
          oracle: ORACLE_HUB,
          collateral: COLLATERAL,
          bookParams: BOOK_PARAMS,
          asset: "BOTNAV",
          slot9: 0n,
          tradingStart: BigInt(input.tradingStart),
          expiry: BigInt(input.expiry),
          // The indexer surfaces this as the contract's `interval`, and the
          // arena's symbol builder prints it on the card. A session is a
          // one-off rather than a rolling series, so the honest value is its
          // own length — a fixed 300 would label a 20-minute session "5m".
          intervalSec: BigInt(input.expiry - input.tradingStart),
          question: `Will agent ${input.agentName} close session #${input.sessionNumber} with a higher NAV?`,
          strike: 0n,
          // abi.encode(address vault, uint256 sessionNumber, bytes32 configHash)
          context: encodeAbiParameters(parseAbiParameters("address, uint256, bytes32"), [
            vault,
            BigInt(input.sessionNumber),
            configHash,
          ]),
        },
        // Our venue runs signer=0x0, so there is nothing to authorise against.
        { deadline: 0n, nonce: 0n, signature: "0x" },
      ],
      value: schedulingCost + resolveReserve,
      gas: MINT_GAS,
    });

    const receipt = await confirm(txHash, "scheduleAndCreateMarket");

    // The module's 20-field MarketCreated, filtered to the module's own address:
    // the MarketCreator factory emits a 13-field event under the same name, and
    // a receipt that contains both must not be decoded by name alone.
    const created = parseEventLogs({
      abi: binaryModuleCreationEventAbi,
      eventName: "MarketCreated",
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === BINARY_MODULE.toLowerCase()),
    });
    const event = created[0];
    if (!event) {
      throw new Error(`scheduleAndCreateMarket mined without a MarketCreated event (tx ${txHash})`);
    }

    return {
      marketId: event.args.marketId.toLowerCase(),
      poolAddress: event.args.pool.toLowerCase(),
      txHash,
    };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One vault, as chain sees it. See {@link readVault}. */
/**
 * What the vault's own `Traded` event says one transaction did.
 *
 * The trade tape used to be whatever a runner posted about itself: the ingest
 * route stored `price`, `quantity`, `cashDelta` and `txHash` verbatim, checked
 * none of them against the chain, and carried no token — so any reachable
 * client could write a trade for any agent with an open session. The comment on
 * that route said "the chain is still the source of truth ... every row carries
 * the transaction hash", which was true only in the sense that the hash was
 * stored. Nothing ever read it back.
 *
 * This reads it back. A row may now only exist if a real transaction to THAT
 * agent's own vault emitted a `Traded` event, and the numbers written are the
 * event's, not the caller's.
 */
export interface VaultTradeReadout {
  marketId: string;
  kind: number;
  /** Raw pool price, in the collateral's units. */
  price: bigint;
  quantity: bigint;
  cashDelta: bigint;
  blockNumber: string;
  /** Block timestamp in ms, so the tape is ordered by the chain's clock. */
  at: number;
}

export async function readVaultTrade(input: {
  txHash: string;
  vault: string;
}): Promise<VaultTradeReadout> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    throw new Error(`txHash is not a transaction hash: ${JSON.stringify(input.txHash)}`);
  }
  const vault = mustAddress(input.vault, "vault");
  const { publicClient } = clients();
  const hash = input.txHash as Hex;

  const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  if (receipt === null) throw new Error("That transaction is not on Shannon.");
  if (receipt.status !== "success") throw new Error("That transaction reverted.");

  // The vault is the only contract whose `trade` moves `protocolCash`, so a
  // trade that did not go THROUGH this agent's vault is not this agent's trade,
  // whatever it claims. Checked on the transaction's `to` and again on the log's
  // emitter, because an inner call could reach a different vault.
  const tx = await publicClient.getTransaction({ hash });
  if ((tx.to ?? "").toLowerCase() !== vault.toLowerCase()) {
    throw new Error(`That transaction went to ${tx.to ?? "a contract creation"}, not to this agent's vault.`);
  }

  const traded = parseEventLogs({ abi: botVaultAbi, eventName: "Traded", logs: receipt.logs })
    .filter((entry) => entry.address.toLowerCase() === vault.toLowerCase());
  if (traded.length === 0) throw new Error("That transaction emitted no Traded event from this agent's vault.");
  // A `trade` call places one order, so one event. If a future batch emits
  // several, the last is the one that left the vault in the state read after it.
  const event = traded[traded.length - 1].args as {
    marketId: Hex; kind: number; price: bigint; quantity: bigint; cashDelta: bigint;
  };

  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);

  return {
    marketId: event.marketId.toLowerCase(),
    kind: Number(event.kind),
    price: event.price,
    quantity: event.quantity,
    cashDelta: event.cashDelta,
    blockNumber: receipt.blockNumber.toString(),
    at: block ? Number(block.timestamp) * 1000 : Date.now(),
  };
}

export interface VaultReadout {
  nav: string;
  protocolCash: string;
  unaccounted: string;
  sessionOpen: boolean;
  sessionNumber: number;
  touched: string[];
  /**
   * The height every field above was read at, or `null` when the node would not
   * serve a pinned read and the figures came from `latest` instead.
   *
   * It is the field that makes a NAV row checkable rather than merely stored:
   * the product's own copy promises "a number anyone can re-derive from two
   * published block numbers", and until this existed every
   * `agent_nav_points.blockNumber` was NULL, so the promise had nothing behind
   * it. A `null` here is honest and prints as nothing; a wrong height would be
   * worse than none at all, because the page invites a stranger to check it.
   */
  blockNumber: string | null;
}

/** The six calls, against one height (or against `latest` when none is given). */
async function readVaultAt(address: Address, blockNumber: bigint | undefined) {
  const { publicClient } = clients();
  // viem treats `blockNumber: undefined` as "use the default block tag", so the
  // pinned and unpinned paths stay one body rather than two that can drift.
  const read = { address, abi: botVaultAbi, blockNumber } as const;

  const [nav, protocolCash, unaccounted, sessionOpen, sessionId, touched] = await Promise.all([
    publicClient.readContract({ ...read, functionName: "nav" }),
    publicClient.readContract({ ...read, functionName: "protocolCash" }),
    publicClient.readContract({ ...read, functionName: "unaccounted" }),
    publicClient.readContract({ ...read, functionName: "sessionOpen" }),
    publicClient.readContract({ ...read, functionName: "sessionId" }),
    publicClient.readContract({ ...read, functionName: "touchedMarkets" }),
  ]);

  return {
    nav: nav.toString(),
    protocolCash: protocolCash.toString(),
    unaccounted: unaccounted.toString(),
    sessionOpen,
    sessionNumber: Number(sessionId),
    touched: touched.map((id) => id.toLowerCase()),
  };
}

/**
 * The vault as chain sees it. Money comes back as raw 6-decimal strings because
 * that is what it is on chain and what `agent_sessions` stores; nothing in this
 * app is allowed to round it into a float on the way past.
 *
 * `unaccounted` is the gap between the token balance and NAV — collateral
 * somebody pushed in with the permissionless faucet. It is returned so the UI
 * can show that the number was excluded, rather than asking anyone to take our
 * word for it.
 *
 * THE HEIGHT IS TAKEN FIRST AND THE CALLS ARE PINNED TO IT, rather than read
 * alongside them. Two reasons, and the second is the one that made it a rule:
 * six separate `eth_call`s at `latest` can straddle a block on a chain that
 * produces them in under a second, so the figures would not even agree with
 * each other; and viem caches `getBlockNumber` for the client's polling
 * interval, so a height fetched in parallel can be seconds older than the
 * `latest` those calls resolved against. A row stamped with a block it was not
 * read at is worse than a row with no block, because the page asks a stranger
 * to re-derive it.
 */
/**
 * The vault's own view of its current session: is one open, which number, and
 * when does the contract think it ends.
 *
 * Separate from {@link readVault} because the caller that needs this is not
 * looking at money. `adoptAgentSession` has to trust the chain over anything a
 * request body claims — an owner who opened a session for four hours must not
 * be able to register it here as ninety minutes, because the meta-market would
 * then expire while the vault is still trading and settle on a NAV that is
 * still moving.
 */
export async function readVaultSession(vault: string): Promise<{
  sessionOpen: boolean;
  sessionNumber: number;
  sessionEnd: number;
  owner: string;
  operator: string;
}> {
  const address = mustAddress(vault, "vault");
  const { publicClient } = clients();
  const read = { address, abi: botVaultAbi } as const;
  const [sessionOpen, sessionId, sessionEnd, owner, operator] = (await Promise.all([
    publicClient.readContract({ ...read, functionName: "sessionOpen" }),
    publicClient.readContract({ ...read, functionName: "sessionId" }),
    publicClient.readContract({ ...read, functionName: "sessionEnd" }),
    publicClient.readContract({ ...read, functionName: "owner" }),
    publicClient.readContract({ ...read, functionName: "operator" }),
  ])) as [boolean, bigint, bigint, Address, Address];

  return {
    sessionOpen,
    sessionNumber: Number(sessionId),
    sessionEnd: Number(sessionEnd),
    owner: owner.toLowerCase(),
    operator: operator.toLowerCase(),
  };
}

export async function readVault(vault: string): Promise<VaultReadout> {
  const address = mustAddress(vault, "vault");
  const { publicClient } = clients();

  const pinned = await publicClient.getBlockNumber().catch(() => null);
  if (pinned !== null) {
    try {
      return { ...(await readVaultAt(address, pinned)), blockNumber: pinned.toString() };
    } catch {
      // Fall through to `latest`. A node that reports a head whose state it
      // cannot serve — the lagging member of a load-balanced pool, most often —
      // must not take the whole reading down with it. The retry below throws
      // the real error if the vault itself is the problem.
    }
  }

  return { ...(await readVaultAt(address, undefined)), blockNumber: null };
}

/**
 * The oracle's whole state in one `eth_call`.
 *
 * `value` is the oracle's frozen answer: 0 = no answer yet (falls outside every
 * registered interval, so the market voids), 1 = YES (NAV rose), 2 = NO. That
 * is `BotNavOracle.OUTCOME_YES = 1`, set by `finalize()` as
 * `navT1 > navT0 ? OUTCOME_YES : OUTCOME_NO`; this line said "1 = NO, 2 = YES"
 * and every screen that believed it scored a loss as a win. Anything else is
 * impossible for a contract we deployed, and is mapped to 0 rather than
 * reported, because "unrecognised" and "no answer" have the same correct
 * consequence and only one of them is safe to guess at.
 */
export async function readOracle(oracle: string): Promise<{
  navT0: string;
  navLive: string;
  closesAt: number;
  opened: boolean;
  finalized: boolean;
  value: 0 | 1 | 2;
}> {
  const address = mustAddress(oracle, "oracle");
  const [navT0, navLive, closesAt, opened, finalized, value] = await clients().publicClient.readContract({
    address,
    abi: botNavOracleAbi,
    functionName: "state",
  });

  return {
    navT0: navT0.toString(),
    navLive: navLive.toString(),
    closesAt: Number(closesAt),
    opened,
    finalized,
    value: value === 1n ? 1 : value === 2n ? 2 : 0,
  };
}

interface IndexerMarketRow {
  voided?: boolean | null;
  winningOutcome?: number | string | null;
  finalized?: boolean | null;
}

interface IndexerResponse {
  data?: { Market?: IndexerMarketRow[] | null } | null;
}

/**
 * What the DreamDEX committee decided about one meta-market.
 *
 * The indexer, not chain: "voided" is the committee declining to answer, and
 * the module exposes it only through the resolution event. `null` means the
 * market is not in the index yet — a mint is visible on chain seconds before it
 * is indexed — and must be read as "not known", never as "not settled".
 *
 * Two different encodings come back, and keeping them apart is the whole point
 * of this function:
 *
 *  - `winningOutcome` is the DreamDEX outcome INDEX — 0 is the market's Up/YES
 *    leg, 1 its Down/NO leg. This is what `agent_sessions.resolvedOutcome`
 *    stores and what the order book paid out on.
 *  - `agentOutcomeValue` is what that means about the AGENT: 1 = NAV rose,
 *    2 = it did not, the same encoding `BotNavOracle.outcomeValue()` uses and
 *    what `agent_sessions.outcomeValue` stores.
 *
 * They are not the same number. Our registration lists the YES interval first
 * (see {@link OUTCOME_YES} and the `numericIntervals` literal above), so index
 * 0 — the Up leg — pays on answer 1. Every translation between the two lives
 * here; deriving it again anywhere else is how a winning agent gets shown as a
 * loser, which is exactly what this docstring caused while it said "NO first".
 */
export async function readMetaMarketSettlement(marketId: string): Promise<{
  voided: boolean;
  winningOutcome: 0 | 1 | null;
  agentOutcomeValue: 1 | 2 | null;
  finalized: boolean;
} | null> {
  // Validated, then interpolated. The indexer's scalar type for `marketId` is
  // not part of any published schema, and a GraphQL variable declared with the
  // wrong one is a runtime error; a string that has already been proven to be
  // 32 bytes of hex cannot carry anything to inject.
  const id = mustBytes32(marketId, "marketId").toLowerCase();

  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{ Market(where:{marketId:{_eq:"${id}"}}) { voided winningOutcome finalized } }`,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`indexer returned ${res.status} reading settlement for ${id}`);
  }

  const body = (await res.json()) as IndexerResponse;
  const row = body.data?.Market?.[0];
  if (!row) return null;

  const raw = row.winningOutcome === null || row.winningOutcome === undefined ? null : Number(row.winningOutcome);
  // A voided market paid nobody, so it has no agent result either — reporting
  // one would turn a refund into a win on the leaderboard.
  const voided = row.voided === true;
  const winningOutcome = voided ? null : raw === 0 ? 0 : raw === 1 ? 1 : null;

  return {
    voided,
    winningOutcome,
    agentOutcomeValue: winningOutcome === null ? null : OUTCOME_INDEX_TO_ANSWER[winningOutcome],
    finalized: row.finalized === true,
  };
}

/**
 * What a vault's held outcome tokens would return if they were redeemed now.
 *
 * `nav()` is `protocolCash` and marks nothing (contracts/BotVault.sol:233), so
 * the moment an agent converts cash into outcome tokens its NAV reads at the
 * cash it did not spend. That is correct — it is the number the meta-market
 * settles on, and marking a position to a thin book would let an operator move
 * their own settlement figure — but a screen that prints only that figure lets
 * a reader conclude the money evaporated. Measured on Alpha-Z session 8: 42.06
 * tUSDC left the vault across seven buys, of which 18.10 was sitting in
 * resolved WINNING legs and 23.96 was a genuine loss, under a card that showed
 * the whole 42.06 as a fall from 52.06 to 10.00.
 *
 * So this is the second number, and it is deliberately NOT folded into NAV.
 *
 * WHAT IS COUNTED. Only a market the indexer reports as finalized, not voided,
 * and carrying a definite winning outcome. For those, a binary market's payout
 * vector is degenerate — the winning leg redeems at par, the losing leg at
 * nothing — so the winning leg's balance IS the collateral it returns. That was
 * checked against chain rather than assumed: tracing `module.redeem` from the
 * vault on all six of that session's markets returned 18,007,000 / 85,000 /
 * 5,000 for the three winners, each exactly the balance held, and zero for the
 * three losers.
 *
 * WHAT IS NOT. An unresolved market has no defensible value — its only price is
 * a book we would be marking ourselves against — and a voided one refunds on
 * rules this does not model. Both are counted in `unpriced` and contribute
 * nothing, so the figure is a floor and never a claim.
 */
export interface RedeemableReadout {
  /** Raw 6dp collateral the winning legs would return today. Never negative. */
  redeemable: string;
  /** Touched markets that were resolved, unvoided, and therefore priced. */
  priced: number;
  /** Touched markets carrying no defensible value: unresolved, voided, unindexed. */
  unpriced: number;
}

interface IndexerMarketIdRow extends IndexerMarketRow {
  marketId?: string | null;
}

/**
 * One indexer round-trip for the whole redeem list.
 *
 * `readMetaMarketSettlement` asks about a single market and is the right shape
 * for a settlement path that handles one. A vault holds up to a handful at
 * once and this runs per poll, so asking `_in` once beats N sequential fetches
 * that would each pay the same latency.
 */
async function settlementsFor(ids: readonly Hex[]): Promise<Map<string, IndexerMarketIdRow>> {
  const out = new Map<string, IndexerMarketIdRow>();
  if (ids.length === 0) return out;

  const list = ids.map((id) => `"${id}"`).join(",");
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{ Market(where:{marketId:{_in:[${list}]}}) { marketId voided winningOutcome finalized } }`,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`indexer returned ${res.status} reading settlements`);

  const body = (await res.json()) as { data?: { Market?: IndexerMarketIdRow[] | null } | null };
  for (const row of body.data?.Market ?? []) {
    if (typeof row.marketId === "string") out.set(row.marketId.toLowerCase(), row);
  }
  return out;
}

/**
 * Two permanent caches, because both facts are write-once.
 *
 * A market's outcome-token ids are fixed at creation — `markets(marketId)` can
 * never return a different pair for the same id — and a settlement is monotonic:
 * once the committee has finalized an unvoided market with a decided outcome,
 * no later read changes it. Everything else here is deliberately short-lived,
 * so these are the only two things allowed to be remembered without an expiry,
 * and both are keyed by market id rather than by vault so agents holding the
 * same contract share the answer.
 *
 * The effect is that a vault priced once costs a single round of `balanceOf`
 * per poll instead of an indexer fetch plus two `eth_call`s per market — which
 * is what made the first read of a six-market vault miss its deadline and show
 * nothing at all on a cold page.
 */
const legIdCache = new Map<string, readonly [bigint, bigint]>();
const decidedCache = new Map<string, 0 | 1>();

async function legIdsFor(id: Hex): Promise<readonly [bigint, bigint]> {
  const hit = legIdCache.get(id);
  if (hit) return hit;
  const market = await clients().publicClient.readContract({
    address: BINARY_MODULE,
    abi: moduleReadsAbi,
    functionName: "markets",
    args: [id],
  });
  // Slot eleven is the Up/YES id and slot twelve the Down/NO id, the same order
  // `BotVault.trade` destructures.
  const pair = [market[10], market[11]] as const;
  legIdCache.set(id, pair);
  return pair;
}

export async function readRedeemable(
  vault: string,
  touched: readonly string[],
): Promise<RedeemableReadout> {
  const owner = mustAddress(vault, "vault");
  const ids = touched.map((id) => mustBytes32(id, "marketId").toLowerCase() as Hex);
  if (ids.length === 0) return { redeemable: "0", priced: 0, unpriced: 0 };

  const { publicClient } = clients();

  // Only the ids whose outcome is not already known need the indexer. A vault
  // that has been priced before therefore skips the fetch entirely, which is
  // the common case on a board that polls.
  const unknown = ids.filter((id) => !decidedCache.has(id));
  let settled = new Map<string, IndexerMarketIdRow>();
  if (unknown.length > 0) {
    // Swallowed: an indexer that is down means "not known", and not-known
    // markets are counted at nothing. It must not delete the figure for the
    // markets already decided.
    settled = await settlementsFor(unknown).catch(() => new Map<string, IndexerMarketIdRow>());
    for (const id of unknown) {
      const row = settled.get(id);
      if (!row || row.finalized !== true || row.voided === true) continue;
      const raw = row.winningOutcome === null || row.winningOutcome === undefined ? null : Number(row.winningOutcome);
      // `winningOutcome` is the DreamDEX outcome INDEX, where 0 is the Up leg —
      // the translation this file documents at `readMetaMarketSettlement`, and
      // it is not re-derived here by hand for a reason.
      if (raw === 0 || raw === 1) decidedCache.set(id, raw);
    }
  }

  // Priced concurrently, and a market that throws is priced at nothing rather
  // than taking the batch down: this figure is a floor, so a read that fails
  // understates it, which is the safe direction for a number a reader is being
  // invited to check.
  const legs = await Promise.all(
    ids.map(async (id) => {
      const winning = decidedCache.get(id);
      if (winning === undefined) return null;
      try {
        const [yesId, noId] = await legIdsFor(id);
        return await publicClient.readContract({
          address: OUTCOME_TOKEN,
          abi: outcomeTokenReadsAbi,
          functionName: "balanceOf",
          args: [owner, winning === 0 ? yesId : noId],
        });
      } catch {
        return null;
      }
    }),
  );

  let redeemable = 0n;
  let priced = 0;
  for (const leg of legs) {
    if (leg === null) continue;
    priced += 1;
    redeemable += leg;
  }

  return { redeemable: redeemable.toString(), priced, unpriced: ids.length - priced };
}
