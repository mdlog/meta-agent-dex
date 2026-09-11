# On-chain evidence

Every claim this project makes was checked against live Somnia Shannon
(chainId 50312) before it was written down. This file is the audit trail: each
row is a transaction anyone can open in the explorer.

Explorer: https://shannon-explorer.somnia.network
Deployer / keeper: `0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE`

## 1. We run our own control plane

Meta-markets are minted on an operator and venue this project registered, so no
third party can close the venue mid-demo. Two transactions, 0.0116 STT total.

| What | Value |
|---|---|
| `registerOperator` | [`0x716c2c44…23c3`](https://shannon-explorer.somnia.network/tx/0x716c2c447d8f997de78ae11cdd96ca70e65cb2ced8da2405f2d53b2cf11623c3) → **operatorId 20** |
| `createVenue` | [`0xc2c2b236…7da7`](https://shannon-explorer.somnia.network/tx/0xc2c2b236c39a56157a353425f2464a3dc39a47021fcd5446dee5367d12027da7) → **venueId `0xa3c034a0398f2cd3465cee88fec2489b78fe26933af4d394d6c87fc4cf00fa77`** |

`policy` and `signer` are both zero, matching the only two venues on the chain
that demonstrably accept third-party market creation. The SDK's docstring says
creation "needs SOME create-side policy set"; the chain disagrees, and the chain
wins.

## 2. A meta-market is a real DreamDEX Event Contract, and it settled

`scheduleAndCreateMarket` (selector `0x94f9fdc7`) is present in the deployed
`BinaryMarketsModule` implementation but is not exported by the SDK. Its
signature was recovered from live calldata and is used directly.

| What | Value |
|---|---|
| `BotNavOracle` deployed | [`0x94969a69…d61b`](https://shannon-explorer.somnia.network/tx/0x94969a691199fed4c33883d82b86fc88992fd1cd4aee2a252eca9a19081fd61b) → `0xa2caf0958a5f93dc2845c55c2a7e1de4a33b2229` |
| Meta-market minted | [`0x695323cf…d2f1`](https://shannon-explorer.somnia.network/tx/0x695323cff5d5a127483967e305ae5d978dc9f24950d45c83a4a5eb1fcf38d2f1) → marketId `0x…01580a`, asset `BOTNAV` |
| Oracle frozen | [`0x338e1f01…4ded`](https://shannon-explorer.somnia.network/tx/0x338e1f019cf009f69729ac1cfde13ac0dbaeeaf4d9ef0a2f6ee37c32b2be4ded) — navT0 0 → navT1 25000000, `outcomeValue() = 1` |
| Committee settled it | `winningOutcome 1`, `voided false`, `payoutNumerators [0, 10000000]` / denominator `10000000` |

The value the committee paid out on is the value our contract returned. NAV was
raised on purpose before settlement so that a correct resolution could not be a
coin flip.

**`winningOutcome` is an interval index, not a word.** The committee reads a
number, finds which registered `numericInterval` contains it, and pays that
index. This spike registered `[(0,0),(1,1)]`, so the oracle's `1` selected index
1. Production meta-markets register `[(1,1),(2,2)]` — **1 = YES (NAV rose),
2 = NO**, the encoding `BotNavOracle.OUTCOME_YES` declares — which maps YES to
outcome index 0 and NO to index 1, and leaves 0 outside every interval so "the
oracle has not answered" voids instead of paying out. Index 0 is the market's
Up leg, so a buyer of Up wins exactly when the agent profits.

Reading this mapping backwards would invert every market on the platform, so it
is asserted in code rather than remembered — and this paragraph said the
opposite until it was re-derived from `finalize()` on 2026-09-07. Everything
that had copied it (`sessionsWon` on the agent board among them) was scoring
losses as wins.

## 3. The vault, not the agent's key, owns the positions

| What | Value |
|---|---|
| Vault | `0x8b25998ddd7107f660764a8f5a730bcc4ef9db03` |
| Real order on a live BTC market | [`0x8658d9ac…35af`](https://shannon-explorer.somnia.network/tx/0x8658d9ac0aebc615a557158041174cc25003a7a82c3a0c7e2ffbb251db4835af) |
| Position after the fill | vault **10 YES**, operator EOA **0** |

`placeBinaryOrder` treats a contract caller exactly like an EOA — both revert
`ERC20InsufficientAllowance` (`0xfb8f41b2`) when unfunded, so there is no
caller-type gate. (`placeBinaryOrderFor`'s `OnlyApprovedContracts()`
(`0x3fb0ba2e`) is a router allowlist and fires identically for both.)

## 4. A wallet top-up cannot move NAV

Shannon's collateral has a permissionless `faucet(uint256)` with no cooldown and
a 10,000-per-call cap, so anyone can push tokens into any address for the price
of gas. A balance-based NAV oracle would therefore be forgeable by a stranger.
Measured against the vault above:

```
faucet 10,000 tUSDC  →  transfer into the vault

balanceOf(vault) = 10,197.91
nav()            =    197.91     ← unchanged
unaccounted()    = 10,000.00     ← the gap, visible to anyone
```

NAV counts `protocolCash`, which moves only by collateral deltas measured inside
an allowlisted DreamDEX call.

## 5. A full agent session, including a real loss

| Step | Result |
|---|---|
| Vault | `0x610736e132abbf36e94a198b74a3a6938b227593` |
| `openSession` | navT0 = 100.00 tUSDC |
| Trade | BUY_YES 20 contracts on market `0x…015861`, nav → 92.60 |
| Market resolved | `winningOutcome 1` (NO), payout `[0, 10000000]` |
| `redeemAll()` (permissionless) | [`0x241bc764…bee8`](https://shannon-explorer.somnia.network/tx/0x241bc7644c2e2c2731dbb8a944ade5094d66d5fdd7f6dba047bb6fe1ca9bbee8) — position 20 → 0, `Redeemed(cashDelta 0)` |
| Session P&L | **−7.40 tUSDC** |

The agent bought YES, NO won, and the contracts expired worthless. That loss is
the product working: a market on "will this agent profit" is only meaningful if
the answer can be no. For the meta-market, navT1 < navT0 → `outcomeValue() = 2`
= NO, which pays outcome index 1 — the Down leg.

## 6. What we measured that contradicts the documentation

| Claim | Reality on Shannon |
|---|---|
| Somnia supports EIP-7702 (per its own JSON-RPC docs) | Type-4 transactions are rejected `invalid transaction` on all three RPCs, while types 0/1/2 reach nonce validation |
| Session keys can scope an agent's Event-Contract trading | Spot-only. The SDK states it: *"A BinaryPool escrows through the module and has no operator gate"* |
| Contract oracle sources are a supported settlement path | The OracleHub prices them at **0.00 STT**, so nothing funds servicing them. 7 of 10 live samples void, against 122 of 20,617 (0.59%) for the paid 6-JSON tier |
| `getSchedulingCost` is stable, so cost can be hardcoded | The resolve reserve derives from `maxFeePerGas`; it is re-quoted per mint |

The third row is why meta-markets register six JSON sources alongside the free
contract source, and why `resolutionTime` sits after expiry rather than on it —
every voided sample used `resolutionTime == expiry`.

## 7. Bugs this testing caught that reading could not

- `redeem` reverted `InsufficientPermission()` (`0xdeda9030`) on every call: the
  vault had never granted the module operator rights on the ERC-6909 singleton.
  The grant now happens in the constructor. The outcome token is one singleton
  for every binary market, so one grant covers the vault's whole life.
- That failure was invisible because `redeemAll` caught it silently. It now
  emits `RedeemFailed`, because a redemption that quietly does not happen
  understates NAV — and NAV is what the meta-market pays out on.
