# YouTube listing for the demo video

Copy as-is. Chapters follow `out/timeline.json` (0:00 / 0:23 / 0:45 / 1:17 /
1:50 / 2:26 for the 2026-09-11 take); re-derive them after a re-shoot.

## Title

Meta-Agent DEX — AI agents trade on Somnia, and other agents price them

Alternatives:
- Meta-Agent DEX: agents trade, other agents price the traders · Somnia × DreamDEX demo
- Meta-Agent DEX — second-layer DreamDEX Event Contracts on AI trading agents (Somnia Shannon)

## Description

AI agents trade real DreamDEX Event Contracts on Somnia Shannon, out of a BotVault they hold no withdrawal key to. Every session mints a second Event Contract — native, on our own operator and venue — asking whether that agent's NAV rises, and a second fleet of agents takes sides on it. Every transaction is signed headlessly through the @somnia-chain/markets-sdk; the web app only watches. Settlement is defined by a contract we deployed and attested by DreamDEX's oracle committee.

Built for the Somnia × DreamDEX Event Contracts Hackathon.

▶ Live app:      https://meta-agent.mdloglabs.org
▶ Audit trail:   https://meta-agent.mdloglabs.org/audit
▶ Source:        https://github.com/mdlog/meta-agent-dex

Chapters
0:00  What this is — the second layer, and why there is no trade ticket
0:23  The agents being measured — vaults, operator keys, one line per decision
0:45  The agents that price the agents — a BOTNAV contract and the book two programs quote
1:17  The number that settles — nav() vs unaccounted(), and why a faucet cannot forge NAV
1:50  Settlement — a session that already closed, read from the chain and the committee
2:26  The receipts — every claim in the video as a transaction on /audit

What you are looking at
• Every screen is the live app on Somnia Shannon (chain 50312) at the time of recording.
• Terminal lines are copied verbatim from the trading agents' and speculators' logs.
• The order book in chapter 3 holds real resting orders placed by a speculator agent; the settled market in chapter 5 was resolved on chain by DreamDEX's oracle committee.
• The explorer page in chapter 4 is a real Shannon Explorer transaction from the agent's trade tape.

Layer 1: trading agents (bots/runner.ts) hold a key that can call exactly one function on their vault — trade(). They cannot withdraw.
Layer 2: speculator agents (bots/speculator.ts) read an agent's record, cash and touched markets, price the BOTNAV contract, and stake collateral to say so. Anyone can run one against the venue.
NAV is nav() on the vault contract, never a token balance: collateral a DreamDEX call delivered counts; anything else lands in unaccounted() and can never reach NAV.

Narrated with a synthetic voice. Testnet only — no real funds.

#Somnia #DreamDEX #EventContracts #PredictionMarkets #AIAgents #DeFi #Hackathon
