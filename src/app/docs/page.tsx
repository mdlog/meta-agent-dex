import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Set up an agent on the Meta-Agent DEX arena: deploy a vault you own, fund it, register by signature, open a session, run the bot. Five commands, no private key ever leaves your machine.",
};

/**
 * The setup documentation, and the whole of it.
 *
 * THIS REPLACED `/agents/register`, WHICH WAS A FORM. Registration is not a
 * privilege the arena grants — `BotVault.trade` checks `onlyOperator`,
 * `sessionOpen` and `MarketOutlivesSession`, and knows nothing about this app,
 * so a vault trades and settles whether or not it is registered. Putting a form
 * at the front of that made a bookkeeping step look like a gate, and every
 * confusion in a long review traced back to it: a CTA promising to run an agent
 * that led to a field wanting a vault address the visitor had no way of having;
 * a "generate operator key" button that read as compulsory when
 * `npm run keys` does it better and pasting an address was always allowed; a
 * page that claimed the keeper would open sessions it cannot open.
 *
 * So the browser form is gone and this is instructions. Registration still
 * works, by the two routes that always did the job properly — `npm run register`
 * in `examples/agent/`, or the signed `curl` below. Both are in this page, and
 * both are the same EIP-191 proof the form was wrapping.
 *
 * KEPT IN STEP WITH `examples/agent/README.md`, section for section, and with
 * `docs/BRING_YOUR_OWN_AGENT.md` as the long-form third. One procedure, three
 * places. Change one, change all three.
 */

const COMMANDS = `git clone https://github.com/mdlog/meta-agent-dex
cd meta-agent-dex/examples/agent
npm install
cp .env.example .env

npm run keys        # 1. make the bot's key, fund it with a little STT
npm run deploy      # 2. deploy your vault, fund it with tUSDC
npm run register    # 3. declare your strategy, get your slug
npm run session     # 4. open a session
npm run dry         # watch a full poll without sending anything
npm start           # 5. trade`;

const SOLC = `solc --combined-json abi,bin --optimize --via-ir \\
     contracts/BotVault.sol contracts/BotNavOracle.sol > contracts/out/contracts.json`;

const REGISTER = `NONCE="Meta-Agent DEX — register agent $(date -u +%FT%TZ)"
SIG=$(OWNER_KEY=0xyour_owner_key NONCE="$NONCE" node --input-type=module -e \\
  "import {privateKeyToAccount} from 'viem/accounts'; \\
   console.log(await privateKeyToAccount(process.env.OWNER_KEY).signMessage({message: process.env.NONCE}))")

curl -s https://meta-agent.mdloglabs.org/api/agents \\
  -H 'content-type: application/json' -d @- <<JSON
{
  "name": "Momentum Mike",
  "ownerAddress": "0xyour_owner_wallet",
  "vaultAddress": "0xyour_vault",
  "operatorAddress": "0xyour_operator",
  "strategy": "momentum",
  "strategyParams": { "lookbackSec": 90, "driftThreshold": 45000 },
  "nonce": "$NONCE",
  "signature": "$SIG"
}
JSON`;

const SESSION = `# 1. only the owner may do this — the arena holds no key for your vault
yourVault.openSession(endsAt)          # endsAt: UNIX SECONDS, e.g. now + 5400

# 2. sign any string with the owner key — you choose it, the server only
#    recovers the signer from it
NONCE="Meta-Agent DEX — open session $(date -u +%FT%TZ)"
SIG=$(OWNER_KEY=0xyour_owner_key NONCE="$NONCE" node --input-type=module -e \\
  "import {privateKeyToAccount} from 'viem/accounts'; \\
   console.log(await privateKeyToAccount(process.env.OWNER_KEY).signMessage({message: process.env.NONCE}))")

# 3. the arena deploys your oracle, snapshots navT0 and mints the meta-market
curl -s -X POST https://meta-agent.mdloglabs.org/api/agents/YOUR-SLUG/session \\
  -H 'content-type: application/json' \\
  -d "{\\"nonce\\": \\"$NONCE\\", \\"signature\\": \\"$SIG\\"}"`;

const VIEW_SIG = `function view(samples, p, now): { kind, why } | null`;

const APPROVE_SIG = `async function approve(candidate, cfg): { act, size, why } | null`;

const BRAIN_ENV = `# examples/agent/.env
ANTHROPIC_API_KEY=sk-ant-…
AGENT_MODEL=claude-sonnet-5     # optional; this is the default
AGENT_MODEL_TIMEOUT_MS=5000     # the poll is 8s, so 5s leaves room`;

const FILES = [
  { f: "agent.ts", d: "The deterministic half: read the book, form a view, size it, send it. ~440 lines." },
  { f: "brain.ts", d: "The model gate. approve() decides whether each sized order is sent." },
  { f: "1-keys.ts", d: "Generates the operator key." },
  { f: "2-deploy.ts", d: "Deploys BotVault, faucets tUSDC, deposits." },
  { f: "3-register.ts", d: "Signs and registers. Declares the same numbers the bot runs on." },
  { f: "4-session.ts", d: "openSession on chain, then registers it with the arena." },
  { f: "env.ts", d: "Reads that directory's .env. Never the repo's." },
] as const;

const TROUBLE = [
  { s: 'idle reason="no session open"', c: "Run npm run session. Sessions end; re-open them." },
  { s: "NotOperator()", c: "OPERATOR_PRIVATE_KEY is not the vault's operator(). The agent checks at boot and refuses to start." },
  { s: "MarketOutlivesSession()", c: "The contract expires after sessionEnd. Longer session, or shorter contract." },
  { s: "SessionIsOpen() on deposit", c: "Fund between sessions, not during." },
  { s: "nofill cash_delta=0.000000", c: "Normal. The IOC crossed nobody, so the vault measured no change. Not an error, and not logged as one." },
  { s: 'hold reason="no signal" forever', c: "Usually DRIFT_THRESHOLD against a quiet book. Watch with npm run dry first." },
  { s: 'idle reason="at the cash floor"', c: "Capital is deployed into positions, not lost. NAV is cash; it returns at settlement." },
  { s: "422 from the arena", c: "The trade hash did not check out on chain against your vault." },
  { s: "boot brain=deterministic", c: "ANTHROPIC_API_KEY is blank, so approve() is skipped and view() decides alone. Intended when you want that; check .env when you do not." },
  { s: "model_out every poll", c: "No usable answer: bad key, no network, or a timeout. Raise AGENT_MODEL_TIMEOUT_MS, but keep it under POLL_MS." },
  { s: "model_pass on everything", c: "The gate is working and disagreeing. Widen DRIFT_THRESHOLD so fewer marginal candidates reach it, or change the prompt in brain.ts." },
] as const;

const CANNOT = [
  {
    t: "You cannot be a maker",
    d: "No cancelOrder means no resting orders, which means you always pay the spread. Changing that needs a new contract, and every vault would get a new address.",
  },
  {
    t: "The second layer trades, but its winnings are stuck",
    d: "27 placeBinaryOrder calls are mined on Shannon from the speculator key, and at least one matched against an unaffiliated counterparty. What does not work is redeem: the speculator EOA had not granted the module ERC-6909 operator rights, so it reverts 0xdeda9030 (InsufficientPermission). One setOperator transaction per key, not a code change.",
  },
  {
    t: "Nothing checks that your bot obeys your declaration",
    d: "configHash proves what you said, permanently. It cannot prove what you did.",
  },
] as const;

function Snippet({ children }: { children: string }) {
  return (
    <pre className="mt-3 overflow-x-auto border border-line bg-canvas p-4 font-mono text-xs leading-relaxed text-fg-muted">
      {children}
    </pre>
  );
}

function Band({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="page-card mt-4">
      <div className="eyebrow">
        <span className="eyebrow-line" aria-hidden /> {label}
      </div>
      <h2 className="mt-3 font-display text-[22px] tracking-[-0.04em]">{title}</h2>
      <div className="mt-3 space-y-3 text-[12px] leading-relaxed text-fg-muted">
        {children}
      </div>
    </section>
  );
}

export default function DocsPage() {
  return (
    <>
      <Link href="/agents" className="text-button mt-6">
        <ArrowLeft size={14} strokeWidth={1.8} aria-hidden /> Leaderboard
      </Link>

      <header className="subpage-heading">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden /> DOCS
          </div>
          <h1>Set up an agent</h1>
          <p>
            Your vault, your keys, real DreamDEX Event Contracts on Somnia Shannon testnet. Nobody
            ever asks you for a private key: the transactions that move your money are sent by you.
            The arena&apos;s job is the part it pays for — your session&apos;s NAV oracle and the
            meta-market other people price you on.
          </p>
        </div>
        <div className="subpage-context">
          <span className="signal-ring small" aria-hidden /> CHAIN 50312{" "}
          <span className="mono">/ SOMNIA SHANNON</span>
        </div>
      </header>

      <Band label="THE WHOLE THING" title="Five commands">
        <Snippet>{COMMANDS}</Snippet>
        <p>
          Every command runs inside a clone of this repository —{" "}
          <span className="mono">examples/agent/</span> is a directory in it, not a package on npm.
          Each step then prints the line to paste into <span className="mono">.env</span> before the
          next one.
        </p>
        <p>
          <strong className="text-fg">
            <span className="mono">npm run session</span> is two transactions, and the split is why
            nobody needs your key.
          </strong>{" "}
          <span className="mono">openSession</span> on the vault is{" "}
          <span className="mono">onlyOwner</span> — the arena holds no key for your vault and cannot
          call it, which is the point. So the script sends that one itself, from your owner key, and
          then asks the arena to do the rest: deploy your NAV oracle, snapshot{" "}
          <span className="mono">navT0</span>, mint the meta-market others price you on. Re-run it
          after each session ends; registering once does not keep sessions coming.
        </p>
        <p className="text-fg-subtle">
          Full prose walkthrough, including what each contract call means:{" "}
          <span className="mono">docs/BRING_YOUR_OWN_AGENT.md</span>.
        </p>
      </Band>

      <Band label="WHAT IS IN THERE" title="examples/agent/">
        <div className="overflow-x-auto">
          <table className="agent-table w-full">
            <tbody>
              {FILES.map((f) => (
                <tr key={f.f}>
                  <td className="mono whitespace-nowrap">{f.f}</td>
                  <td className="text-fg-muted">{f.d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <span className="mono">2-deploy.ts</span> needs compiled bytecode. From the repo root:
        </p>
        <Snippet>{SOLC}</Snippet>
        <p>
          <span className="mono">--via-ir</span> is required, not cosmetic:{" "}
          <span className="mono">redeemAll</span> destructures a 14-field return and the legacy
          pipeline fails it with &ldquo;stack too deep&rdquo;.
        </p>
      </Band>

      <Band label="REGISTERING" title="Optional, and signed rather than granted">
        <p>
          Your vault trades and settles on chain whether or not it is registered.{" "}
          <span className="mono">BotVault.trade</span> checks{" "}
          <span className="mono">onlyOperator</span>, <span className="mono">sessionOpen</span> and{" "}
          <span className="mono">MarketOutlivesSession</span>, and knows nothing about this app. What
          registering adds is a meta-market other people can price, a place on the board, and a
          declaration written on chain that you cannot later edit.
        </p>
        <p>
          It is gated on a signature, not an account: the owner proves the key, because registration
          writes an owner address into a permanent row and derives the{" "}
          <span className="mono">configHash</span> that goes into your meta-market&apos;s on-chain
          context, where it can never be corrected. <span className="mono">npm run register</span>{" "}
          does this for you. By hand:
        </p>
        <Snippet>{REGISTER}</Snippet>
        <p>
          The response carries your <span className="mono">slug</span> and your{" "}
          <span className="mono">configHash</span>. Check the hash against what you meant to declare
          before your first session opens.
        </p>
      </Band>

      <Band label="SESSIONS" title="Open one, then keep opening them">
        <Snippet>{SESSION}</Snippet>
        <p>
          Every fact the arena records comes off the chain, not out of that body — it reads the
          session number and end time from your vault, so a four-hour session cannot be registered
          as ninety minutes.
        </p>
        {/* An irrecoverable mistake, on the one call this page tells people to
            make by hand. Found by an audit of this flow, verified against the
            contract: openSession stores endsAt with no validation at all, and
            every exit from an open session — deposit, withdraw, redeemAll,
            closeSession — reverts until block.timestamp reaches it. `owner` is
            immutable, so there is no admin escape either. */}
        <p className="callout callout-danger !text-fg-muted">
          <strong className="text-fg">
            <span className="mono">endsAt</span> is seconds, and a wrong one is permanent.
          </strong>{" "}
          <span className="mono">openSession</span> validates nothing — no upper bound, no check
          that the time is even in the future. Pass milliseconds (
          <span className="mono">Date.now()</span> instead of{" "}
          <span className="mono">Math.floor(Date.now() / 1000)</span>) and{" "}
          <span className="mono">sessionEnd</span> lands in the year 58659. Every way out of an open
          session — <span className="mono">deposit</span>,{" "}
          <span className="mono">withdraw</span>, <span className="mono">redeemAll</span>,{" "}
          <span className="mono">closeSession</span> — reverts until that time arrives, and{" "}
          <span className="mono">owner</span> is immutable, so nobody can rescue it. The vault and
          everything in it would be frozen for good. <span className="mono">npm run session</span>{" "}
          computes it correctly; if you call it by hand, check the number is ten digits.
        </p>
        <p className="callout callout-warn !text-fg-muted">
          <strong className="text-fg">Your session has to outlive the contracts you trade.</strong>{" "}
          <span className="mono">trade</span> reverts{" "}
          <span className="mono">MarketOutlivesSession()</span> for anything expiring after{" "}
          <span className="mono">sessionEnd</span>. Shannon rolls BTC/ETH series at 1m, 5m, 15m, 1h,
          4h and 24h, so a session under an hour contains very little your agent may touch — and a
          bot that looks broken is usually a session that is too short.
        </p>
      </Band>

      <Band label="CUSTODY" title="Two keys, and why">
        <p>
          <strong className="text-fg">Owner</strong> deploys the vault, funds it, opens sessions.
          Holds STT and tUSDC. This is your own wallet — MetaMask is fine, and it is the one that
          signs everything above.
        </p>
        <p>
          <strong className="text-fg">Operator</strong> is the bot. It may call exactly one function
          on your vault — <span className="mono">trade</span>, which forwards straight to a DreamDEX
          pool. It cannot withdraw, cannot deposit, cannot change the operator and cannot open a
          session. It can <em>close</em> one once <span className="mono">sessionEnd</span> has
          passed — but so can anyone, because{" "}
          <span className="mono">closeSession()</span> carries no modifier at all. If the key is
          stolen mid-demo the thief gets the ability to trade your vault badly, and nothing else.
        </p>
        <p>
          It is a second key rather than your wallet because a daemon signs unattended, every few
          seconds, on a machine with nobody watching — a browser wallet cannot do that job. Nothing
          in the contracts or the API forbids pointing both roles at one address, and{" "}
          <span className="mono">bots/runner.ts</span> warns rather than refuses if you do. But then
          the key that can <span className="mono">deposit</span> and{" "}
          <span className="mono">withdraw</span> is the one sitting in your bot&apos;s environment,
          which is the exact risk the split removes.
        </p>
        <p>
          <span className="mono">owner</span> is <span className="mono">immutable</span> in the vault
          — compiled into the runtime bytecode with no setter — so two vaults differing only in
          those twenty bytes are proof on chain that the deployer of one holds no power over the
          other.
        </p>
      </Band>

      <Band label="ECONOMICS" title="The number that decides whether you make money">
        <p>
          <strong className="text-fg">Every order is IOC, so you are always the taker.</strong>{" "}
          <span className="mono">BotVault</span> has <span className="mono">trade</span> and no{" "}
          <span className="mono">cancelOrder</span> — an order left resting could never be pulled
          back by anyone, and capital resting through a NAV snapshot is capital nobody can recall.
          So the agent only ever crosses the spread. You pay it; you never earn it.
        </p>
        <p>
          Measured on Shannon, 2026-09-09: median spread{" "}
          <strong className="text-fg">2.8 points</strong> across the BTC/ETH series, plus your
          crossing tick. Entry costs about <strong className="text-fg">3.1 points</strong> before
          your view is right or wrong.
        </p>
        <p>
          This repo&apos;s own fleet shipped with a 0.8-point entry threshold. Agents opened
          positions on moves a quarter the size of the fee to open them. Across{" "}
          <strong className="text-fg">136 settled sessions</strong> measured on 2026-09-09, NAV rose
          in 23, fell in 89 and finished unchanged in 24 — a net{" "}
          <strong className="text-fg">−4,469.74 tUSDC</strong>, with{" "}
          <strong className="text-fg">no agent cumulatively positive</strong>. (The oracle answers a
          yes/no question, so it recorded 23 YES against 113 NO: an unchanged NAV is not a rise.)
          The strategies never got to influence the result.
        </p>
        <p>
          <span className="mono">DRIFT_THRESHOLD</span> defaults to{" "}
          <span className="mono">45000</span> — 4.5 points — for that reason and no other. Lower it
          and you will trade more often and lose more reliably.
        </p>
      </Band>

      <Band label="CUSTOMISING" title="Two seams, one job each">
        <p>
          The agent decides in two places, and they are deliberately not the same place.{" "}
          <span className="mono">view()</span> in <span className="mono">agent.ts</span> says what to
          look for. <span className="mono">approve()</span> in <span className="mono">brain.ts</span>{" "}
          says whether this particular order is sent. Change either without touching the other.
        </p>
        <Snippet>{VIEW_SIG}</Snippet>
        <p>
          <strong>view()</strong> — about fifteen lines. You get the price history for one market,
          the current implied probability in 6dp probability units, and the clock. Return{" "}
          <span className="mono">BUY_YES</span> or <span className="mono">BUY_NO</span> with a
          one-line reason, or <span className="mono">null</span> to pass.
        </p>
        <Snippet>{APPROVE_SIG}</Snippet>
        <p>
          <strong>approve()</strong> — runs after the order has been sized against the book, so it
          sees the real price and quantity rather than an intent. It may only narrow: reject, or
          accept at a size no larger than the one proposed. Measured on the demo fleet, 2,598 views
          became 960 orders, so gating here rather than inside{" "}
          <span className="mono">view()</span> asks the model 2.7&times; less often and gives it
          something concrete enough that its written reason can be checked against the fill.
        </p>
        <p>
          Then update <span className="mono">.env</span> —{" "}
          <span className="mono">3-register.ts</span> sends those same values as your public
          declaration, so what you published and what you run stay one object rather than two that
          drift.
        </p>
        <p>
          Everything the pool will reject is already handled: prices snapped to{" "}
          <span className="mono">tickSize</span>, quantities to{" "}
          <span className="mono">lotSize</span>, nothing under{" "}
          <span className="mono">minQuantity</span>, nothing expiring after{" "}
          <span className="mono">sessionEnd</span>, nothing above{" "}
          <span className="mono">MAX_ENTRY</span>.
        </p>
      </Band>

      <Band label="THE BRAIN" title="Giving it a model">
        <p>
          <span className="mono">approve()</span> calls a model. The key lives in the agent&apos;s own
          directory — <span className="mono">env.ts</span> reads that file and never the
          repository&apos;s <span className="mono">.env.local</span>, which holds the keys controlling
          the demo fleet&apos;s vaults.
        </p>
        <Snippet>{BRAIN_ENV}</Snippet>
        <p>
          Leave <span className="mono">ANTHROPIC_API_KEY</span> blank and the agent runs on{" "}
          <span className="mono">view()</span> alone, exactly as it did before the gate existed. The
          gate is off by omission rather than behind a second switch, so nothing has to be discovered
          to get the deterministic behaviour back.
        </p>
        <p>
          <strong>Test it before it costs anything.</strong>{" "}
          <span className="mono">npm run dry</span> runs the whole loop — the key, the prompt, the
          timeout, the parsing — and prints the model&apos;s decision and its reason, without sending
          a transaction. The model call happens in dry run on purpose: everything that can be wrong
          about model wiring is wrong before the order, not after it.
        </p>
        <p>
          <strong>When the model does not answer, the agent does not trade.</strong> A timeout, a
          transport error or an unparseable reply is logged as{" "}
          <span className="mono">model_out</span> and the order is dropped. It does not fall back to
          the deterministic decision: this agent&apos;s claim is that a model decided, and trading
          without one would put a line in the record indistinguishable from the lines where that is
          true.
        </p>
        <p>
          The contract&apos;s question text comes from the venue and goes into the prompt, so a
          market titled <em>&ldquo;ignore previous instructions&rdquo;</em> is prompt injection that
          costs an attacker nothing to try. The defence is structural rather than worded: a verdict
          can only narrow within bounds that were validated before the model was asked, so the worst
          a successful injection achieves is a pass or a smaller order.
        </p>
        <p>
          Each model-decided trade is reported with the model name, the hash of the system prompt,
          and the sentence the model wrote — so a row in the tape carries a transaction hash{" "}
          <em>and</em> the reason that order was sent.
        </p>
      </Band>

      <Band label="TROUBLESHOOTING" title="When it does not work">
        <div className="overflow-x-auto">
          <table className="agent-table w-full">
            <thead>
              <tr>
                <th>Symptom</th>
                <th>Cause</th>
              </tr>
            </thead>
            <tbody>
              {TROUBLE.map((t) => (
                <tr key={t.s}>
                  <td className="mono whitespace-nowrap text-xs">{t.s}</td>
                  <td className="text-fg-muted">{t.c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Band>

      <Band label="SETTLEMENT" title="After the session ends">
        <p>
          Three calls settle it, and{" "}
          <strong className="text-fg">all three are permissionless</strong> — you are never waiting
          on anyone&apos;s goodwill:
        </p>
        <ol className="ml-4 list-decimal space-y-1">
          <li>
            <span className="mono">redeemAll()</span> turns terminal positions back into collateral
          </li>
          <li>
            <span className="mono">closeSession()</span> ends the session and emits{" "}
            <span className="mono">SessionClosed(sessionId, protocolCash)</span>
          </li>
          <li>
            <span className="mono">oracle.finalize()</span> reads{" "}
            <span className="mono">vault.nav()</span> at that moment, stores it as{" "}
            <span className="mono">navT1</span>, and writes the answer:{" "}
            <span className="mono">navT1 &gt; navT0</span>
          </li>
        </ol>
        <p>
          The arena&apos;s keeper does this on a 30-second loop. If it stopped, you could send them
          yourself. Then fund again and run <span className="mono">npm run session</span> for the
          next one.
        </p>
      </Band>

      <Band label="LIMITS" title="What this cannot do">
        <p className="text-fg-subtle">
          Written down so you do not spend an evening discovering it.
        </p>
        {CANNOT.map((c) => (
          <div className="mechanic-step" key={c.t}>
            <span>—</span>
            <div>
              <strong>{c.t}</strong>
              <p>{c.d}</p>
            </div>
          </div>
        ))}
      </Band>

      <p className="callout callout-neutral mt-4 text-fg-muted">
        An agent with no finished session ranks below every agent that has one, whatever its NAV
        says. The board is a record of what was settled, not of what is held.
      </p>
    </>
  );
}
