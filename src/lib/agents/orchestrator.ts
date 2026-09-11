/**
 * Session lifecycle — the piece that turns contracts into a product.
 *
 * A session is the window a meta-market is written against, and it has to line
 * up three clocks that do not know about each other:
 *
 *   vault.sessionEnd  the last second the agent may hold a position
 *   market.expiry     the last second anyone may bet on the agent
 *   resolutionTime    when the committee reads the oracle
 *
 * They are set to `close`, `close`, and `close + SETTLE_WINDOW_SEC`. The gap is
 * not padding: redeemAll, closeSession and finalizeOracle all have to be mined
 * inside it, and every voided third-party market we decoded had put the read
 * exactly on expiry with no room at all.
 *
 * Timestamps are seconds on chain and milliseconds in the database, and the two
 * are never the same variable here — `agentSessions` rejects a seconds-scale
 * number outright rather than storing a 1970 date.
 */

import {
  closeVaultSession,
  deployOracle,
  deployVault,
  finalizeOracle,
  fundVault,
  mintMetaMarket,
  openOracle,
  openVaultSession,
  readMetaMarketSettlement,
  readOracle,
  readVault,
  readVaultSession,
  redeemAll,
  topUpVault,
} from "@/lib/agents/chain";
import { createAgent, getAgentById, type CreateAgentInput } from "@/lib/services/agents";
import {
  createSession,
  getSession,
  listAwaitingCommittee,
  listOpenSessions,
  recordNavPoint,
  updateSession,
} from "@/lib/services/agentSessions";
import type { Agent, AgentSession } from "@/lib/domain/types";

/**
 * Seconds between a market closing and the committee reading the oracle. Three
 * transactions have to land in here, so it is sized for a bad minute on the
 * chain rather than a good one.
 */
export const SETTLE_WINDOW_SEC = 180;

/**
 * How long to wait after a session closes before redeeming.
 *
 * The vault only ever holds markets that expire inside the session, but expiry
 * is not settlement: DreamDEX finalizes a market in a separate transaction, and
 * redeeming before that lands reverts. `redeemAll` swallows the failure by
 * design so one bad market cannot strand the rest, which made this look like a
 * loss rather than a bug — a live agent closed a session still holding 17.22
 * tUSDC of a market that settled moments later, and its meta-market resolved on
 * the understated number.
 *
 * The grace fits inside SETTLE_WINDOW_SEC with room for redeemAll, closeSession
 * and finalize to be mined before the committee reads the oracle.
 */
const REDEEM_GRACE_SEC = 60;

/** Opening balance for a demo agent, in raw 6-decimal collateral units. */
const DEFAULT_FUNDING = 250_000_000n;

/**
 * NAV every agent is raised to at the start of each session, in raw 6-decimal
 * units. `0` turns the top-up off entirely.
 *
 * The same number for everyone is the point, not a convenience: a leaderboard
 * whose agents start each session on different capital ranks wallet size as
 * much as strategy. Levelling at the open is what makes "this agent gained 12%"
 * a claim about how it traded.
 *
 * It only ever raises. Nothing here withdraws from an agent that finished ahead
 * — a vault at 380 keeps its 380, because taking a winner's gains back would
 * delete the very result the board exists to show.
 */
const SESSION_TARGET_NAV = BigInt(process.env.AGENT_SESSION_TARGET_NAV ?? "200000000");

/**
 * A market minted with less runway than this has no useful life: bettors need
 * time to price it and the agent needs time to trade into the NAV it settles on.
 */
const MIN_TRADEABLE_REMAINDER_SEC = 240;

const nowSec = () => Math.floor(Date.now() / 1000);
const secToMs = (s: number) => s * 1000;

function publicOrigin(): string {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? process.env.APP_ORIGIN;
  if (!origin) {
    throw new Error(
      "NEXT_PUBLIC_APP_ORIGIN is not set. The oracle committee fetches the mirror over the public internet, " +
        "so a localhost origin would make every market void.",
    );
  }
  return origin.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionInput extends Omit<CreateAgentInput, "vaultAddress"> {
  /** Raw 6-decimal units. Omit for the default opening balance. */
  funding?: bigint;
}

/**
 * Deploy a vault, fund it, and register the agent against it.
 *
 * The vault address is the agent's identity: it is what the chain knows, what
 * the meta-market's `context` records, and what NAV is read from. Registering an
 * agent without one would leave a row nothing can settle.
 */
export async function provisionAgent(input: ProvisionInput): Promise<{ agent: Agent; vaultTx: string; fundTx: string }> {
  const { address: vaultAddress, txHash: vaultTx } = await deployVault({
    owner: input.ownerAddress,
    operator: input.operatorAddress,
  });

  const { txHash: fundTx } = await fundVault({ vault: vaultAddress, amount: input.funding ?? DEFAULT_FUNDING });

  const agent = createAgent({
    name: input.name,
    ownerAddress: input.ownerAddress,
    vaultAddress,
    operatorAddress: input.operatorAddress,
    strategy: input.strategy,
    strategyParams: input.strategyParams,
    repoUrl: input.repoUrl ?? null,
    blurb: input.blurb ?? null,
  });

  const state = await readVault(vaultAddress);
  // `blockNumber` is the height `readVault` pinned its calls to, and it is not
  // decoration: the Overview promises "one NAV number pinned by two published
  // block numbers", and every row written before this omitted the argument, so
  // the column was NULL on every sample the product pointed at. Passing what
  // the read already knows is the whole fix.
  recordNavPoint({
    agentId: agent.id,
    sessionId: null,
    nav: state.nav,
    unaccounted: state.unaccounted,
    blockNumber: state.blockNumber,
    at: Date.now(),
  });

  return { agent, vaultTx, fundTx };
}

// ---------------------------------------------------------------------------
// Opening a session
// ---------------------------------------------------------------------------

/**
 * Open the vault session, deploy and arm its oracle, and mint the meta-market.
 *
 * Order is load-bearing. The vault session opens first so that `navT0` is fixed
 * before anything can trade against it; the oracle is deployed against that
 * already-open session; and the market is minted last, because a market whose
 * oracle did not exist yet is a market that can only void.
 */
export async function openAgentSession(input: { agentId: string; durationSec: number }): Promise<AgentSession> {
  const agent = getAgentById(input.agentId);
  if (!agent) throw new Error(`unknown agent ${input.agentId}`);
  if (input.durationSec < 120) throw new Error("a session shorter than two minutes cannot contain a tradeable market");

  const opensAtSec = nowSec();
  const closesAtSec = opensAtSec + input.durationSec;

  // The only moment a deposit is possible: the previous session is closed and
  // the next has not started. See `topUpVault` for why this cannot be a
  // scheduled job outside the keeper. A failure here is reported, never thrown
  // — an agent that could not be funded still gets its session.
  if (SESSION_TARGET_NAV > 0n) {
    try {
      const top = await topUpVault({ vault: agent.vaultAddress, target: SESSION_TARGET_NAV });
      if (top.note !== null) {
        console.warn(`[session] ${agent.slug}: not topped up — ${top.note}`);
      }
    } catch (e) {
      console.warn(`[session] ${agent.slug}: top-up failed — ${(e as Error).message}`);
    }
  }

  const opened = await openVaultSession({ vault: agent.vaultAddress, endsAt: closesAtSec });
  const { address: oracleAddress } = await deployOracle({
    vault: agent.vaultAddress,
    closesAt: closesAtSec,
    sessionNumber: opened.sessionNumber,
  });
  const armed = await openOracle({ oracle: oracleAddress });

  const session = createSession({
    agentId: agent.id,
    sessionNumber: opened.sessionNumber,
    oracleAddress,
    opensAt: secToMs(opensAtSec),
    closesAt: secToMs(closesAtSec),
    openTx: opened.txHash,
  });

  // The mint is the one step that can fail on cost or on a venue policy change.
  // If it does, the session stays `pending`: the agent may still trade and the
  // vault still settles, there is simply nothing to bet on — which is a far
  // better failure than a market nobody can resolve.
  try {
    const minted = await mintMetaMarket({
      oracle: oracleAddress,
      vault: agent.vaultAddress,
      agentName: agent.name,
      sessionNumber: opened.sessionNumber,
      configHash: agent.configHash,
      tradingStart: opensAtSec,
      expiry: closesAtSec,
      resolutionTime: closesAtSec + SETTLE_WINDOW_SEC,
      oracleUrlBase: publicOrigin(),
    });

    return updateSession(session.id, {
      metaMarketId: minted.marketId,
      metaPoolAddress: minted.poolAddress,
      mintTx: minted.txHash,
      navT0: armed.navT0,
      status: "open",
    });
  } catch (err) {
    // Keep navT0 — the vault session is genuinely open and will still settle;
    // only the thing people bet on is missing. Then rethrow, because a caller
    // that believes it opened a market when it did not will mint a second one.
    updateSession(session.id, { navT0: armed.navT0, status: "pending" });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Closing a session
// ---------------------------------------------------------------------------

/**
 * Redeem, close, freeze — in that order, and all three permissionless.
 *
 * Redeeming first is what makes NAV meaningful: an unredeemed winning position
 * is worth nothing to `protocolCash`, so freezing before redemption would settle
 * a profitable agent as a loss. Anyone may call this; the keeper is just usually
 * first.
 */
/**
 * Register a session an outside owner has already opened on their own vault.
 *
 * WHY THIS EXISTS AT ALL. `openAgentSession` signs `openSession` itself, and
 * that call is `onlyOwner`. For the demo fleet the server holds the owner keys,
 * so it works. For a vault someone else deployed it cannot: `ownerWallet`
 * throws, the cycle route records the error and moves on, and the visitor's
 * agent sits registered forever with no session — its runner polling, its
 * `trade` reverting `SessionNotOpen()`, and nothing on any page saying why.
 * That made "bring your own agent" a claim the product could not honour.
 *
 * The split is the fix, and it is the honest one: the owner sends the one
 * transaction only the owner may send, and the arena does the rest — deploy the
 * oracle, arm it, mint the meta-market — which it pays for and which needs no
 * key of theirs. Nobody ever hands over a private key to take part.
 *
 * EVERY FIGURE HERE COMES OFF THE CHAIN, none from the caller. The session
 * number and end time are read from the vault, so a request cannot describe a
 * session differently from the one that exists: an owner who opened four hours
 * cannot register ninety minutes and have the meta-market expire while the
 * vault is still trading, settling on a NAV that has not stopped moving.
 */
export async function adoptAgentSession(input: { agentId: string }): Promise<AgentSession> {
  const agent = getAgentById(input.agentId);
  if (!agent) throw new Error(`unknown agent ${input.agentId}`);

  const onchain = await readVaultSession(agent.vaultAddress);
  if (!onchain.sessionOpen) {
    throw new Error(
      `Vault ${agent.vaultAddress} has no open session. Call openSession(endsAt) on it from the owner wallet first.`,
    );
  }
  if (onchain.operator !== agent.operatorAddress.toLowerCase()) {
    throw new Error(
      `Vault ${agent.vaultAddress} has operator ${onchain.operator}, but ${agent.slug} is registered with ${agent.operatorAddress}. ` +
        "Call setOperator on the vault, or register an agent that matches it.",
    );
  }

  const closesAtSec = onchain.sessionEnd;
  const opensAtSec = nowSec();
  if (closesAtSec - opensAtSec < 120) {
    throw new Error(
      `That session ends in ${closesAtSec - opensAtSec}s. A session shorter than two minutes cannot contain a tradeable market.`,
    );
  }

  // Deliberately no `topUpVault` on this path. The vault belongs to someone
  // else, its session is already open so `deposit` would revert anyway, and
  // funding a stranger's agent out of the keeper's balance is not the arena's
  // to do — the same rule `fund-vaults` follows for independently owned vaults.

  const { address: oracleAddress } = await deployOracle({
    vault: agent.vaultAddress,
    closesAt: closesAtSec,
    sessionNumber: onchain.sessionNumber,
  });
  const armed = await openOracle({ oracle: oracleAddress });

  const session = createSession({
    agentId: agent.id,
    sessionNumber: onchain.sessionNumber,
    oracleAddress,
    opensAt: secToMs(opensAtSec),
    closesAt: secToMs(closesAtSec),
    // The owner sent `openSession`, so the arena never saw that hash. Recording
    // one it did not broadcast would be a fabricated citation on an audit page;
    // the oracle's own `SessionOpened` event carries the same fact, signed by
    // the chain.
    openTx: null,
  });

  try {
    const minted = await mintMetaMarket({
      oracle: oracleAddress,
      vault: agent.vaultAddress,
      agentName: agent.name,
      sessionNumber: onchain.sessionNumber,
      configHash: agent.configHash,
      tradingStart: opensAtSec,
      expiry: closesAtSec,
      resolutionTime: closesAtSec + SETTLE_WINDOW_SEC,
      oracleUrlBase: publicOrigin(),
    });

    return updateSession(session.id, {
      metaMarketId: minted.marketId,
      metaPoolAddress: minted.poolAddress,
      mintTx: minted.txHash,
      navT0: armed.navT0,
      status: "open",
    });
  } catch (err) {
    updateSession(session.id, { navT0: armed.navT0, status: "pending" });
    throw err;
  }
}

export async function settleAgentSession(sessionId: string): Promise<AgentSession> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);
  const agent = getAgentById(session.agentId);
  if (!agent) throw new Error(`session ${sessionId} has no agent`);

  const redeemableAt = session.closesAt + REDEEM_GRACE_SEC * 1000;
  if (Date.now() < redeemableAt) {
    throw new Error(
      `session ${sessionId} is not redeemable until ${new Date(redeemableAt).toISOString()} ` +
        `(closed ${new Date(session.closesAt).toISOString()}, plus a ${REDEEM_GRACE_SEC}s settlement grace)`,
    );
  }

  updateSession(session.id, { status: "closing" });

  // Read before writing: this function is now retryable, and both calls below
  // revert `SessionNotOpen` on a vault that is already closed. A retry has to
  // pick up where the failed attempt stopped rather than repeat its first step.
  const before = await readVault(agent.vaultAddress);
  if (before.sessionOpen) {
    await redeemAll({ vault: agent.vaultAddress });
    await closeVaultSession({ vault: agent.vaultAddress });
  }
  const finalized = await finalizeOracle({ oracle: session.oracleAddress });

  const oracle = await readOracle(session.oracleAddress);
  const vault = await readVault(agent.vaultAddress);
  // The closing sample, with the height it was read at — this is the point a
  // reader pairs with the opening one to re-derive the session's answer.
  recordNavPoint({
    agentId: agent.id,
    sessionId: session.id,
    nav: vault.nav,
    unaccounted: vault.unaccounted,
    blockNumber: vault.blockNumber,
    at: Date.now(),
  });

  return updateSession(session.id, {
    navT1: oracle.navLive,
    outcomeValue: oracle.value === 1 || oracle.value === 2 ? oracle.value : null,
    finalizeTx: finalized.txHash,
    status: "finalized",
  });
}

// ---------------------------------------------------------------------------
// Following the committee
// ---------------------------------------------------------------------------

/**
 * Pull DreamDEX's verdict for every session waiting on one.
 *
 * A void is recorded as a void, never as a loss. The committee refunding both
 * sides is not the agent failing, and a leaderboard that conflated the two would
 * punish agents for an oracle's bad minute.
 */
export async function syncSettlements(): Promise<{ checked: number; settled: number; voided: number }> {
  const waiting = listAwaitingCommittee();
  let settled = 0;
  let voided = 0;

  for (const session of waiting) {
    const verdict = await readMetaMarketSettlement(session.metaMarketId as string).catch(() => null);
    if (!verdict || (!verdict.voided && verdict.winningOutcome === null)) continue;

    if (verdict.voided) {
      updateSession(session.id, { voided: true, status: "void" });
      voided += 1;
    } else {
      updateSession(session.id, { resolvedOutcome: verdict.winningOutcome, status: "settled" });
      settled += 1;
    }
  }

  return { checked: waiting.length, settled, voided };
}

/**
 * Mint the market for a session that opened without one.
 *
 * `openAgentSession` deliberately leaves a session `pending` rather than
 * unwinding it when the mint fails: the vault session is genuinely open, navT0
 * is genuinely recorded, and the agent can genuinely trade — the only missing
 * piece is the thing people bet on. Mint failures are recoverable and often
 * transient (a gas ceiling, a re-quoted cost, a busy venue), so the keeper
 * retries rather than throwing the session away.
 *
 * A session is only worth minting against while there is still time to trade
 * and settle inside it; past that, leave it to be settled as a session nobody
 * could bet on, which is honest.
 */
export async function retryPendingMints(): Promise<{ minted: number; failed: { agent: string; message: string }[] }> {
  const failed: { agent: string; message: string }[] = [];
  let minted = 0;

  const pending = listOpenSessions().filter((s) => s.status === "pending" && !s.metaMarketId);
  for (const session of pending) {
    const agent = getAgentById(session.agentId);
    if (!agent) continue;

    const closesAtSec = Math.floor(session.closesAt / 1000);
    const nowS = nowSec();
    if (closesAtSec - nowS < MIN_TRADEABLE_REMAINDER_SEC) continue;

    try {
      const minted_ = await mintMetaMarket({
        oracle: session.oracleAddress,
        vault: agent.vaultAddress,
        agentName: agent.name,
        sessionNumber: session.sessionNumber,
        configHash: agent.configHash,
        tradingStart: nowS,
        expiry: closesAtSec,
        resolutionTime: closesAtSec + SETTLE_WINDOW_SEC,
        oracleUrlBase: publicOrigin(),
      });
      updateSession(session.id, {
        metaMarketId: minted_.marketId,
        metaPoolAddress: minted_.poolAddress,
        mintTx: minted_.txHash,
        status: "open",
      });
      minted += 1;
    } catch (err) {
      failed.push({ agent: agent.name, message: (err as Error).message });
    }
  }

  return { minted, failed };
}

/** Sessions whose close time has passed but which have not been settled yet. */
export function dueForSettlement(at: number = Date.now()): AgentSession[] {
  return listOpenSessions().filter(
    (s) =>
      (s.status === "open" || s.status === "pending" || s.status === "closing") &&
      s.closesAt + REDEEM_GRACE_SEC * 1000 <= at,
  );
}
