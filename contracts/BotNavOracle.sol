// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBotVault {
    function nav() external view returns (uint256);
    function sessionOpen() external view returns (bool);
    function touchedCount() external view returns (uint256);
}

/**
 * The settlement source for one meta-market. DreamDEX's oracle committee reads
 * `outcomeValue()` at the market's resolutionTime and votes on what it saw.
 *
 * Answer encoding is 1 = YES (NAV rose), 2 = NO (it did not), registered
 * against numeric intervals [(1,1),(2,2)]. Zero is deliberately outside both.
 * Using 0/1 would make "the agent lost" and "this contract has no answer yet"
 * the same number to the committee, and that is not fixable after a market is
 * minted — so an unfinalized session reads as 0, falls outside every valid
 * interval, and voids. Voiding is the correct failure: it refunds both sides
 * rather than paying out on a number nobody computed.
 *
 * `outcomeValue()` must never revert. A subcommittee that cannot agree voids the
 * market, and a revert is the surest way to disagree.
 *
 * NAV comes from `vault.nav()` — collateral the vault received through DreamDEX —
 * and never from a token balance. Shannon's collateral has a permissionless,
 * cooldown-free faucet, so a balance-based oracle could be forged by anyone for
 * the price of gas.
 */
contract BotNavOracle {
    /// Answer 1 lands in the FIRST registered interval, and DreamDEX pays the
    /// outcome INDEX that interval sits at. Index 0 is the market's Up/YES leg
    /// (`markets()` returns yesId before noId). So "NAV rose" must be 1, or a
    /// retail buyer of Up would win precisely when the agent lost — measured on
    /// our own settled market 0x…1580a, which registered [[0,0],[1,1]], read 1
    /// and finalized winningOutcome 1 with payout [0, 1e7].
    uint256 public constant OUTCOME_YES = 1;
    uint256 public constant OUTCOME_NO = 2;

    IBotVault public immutable vault;
    address public immutable keeper;
    uint64 public immutable closesAt;
    uint256 public immutable sessionId;

    uint256 public navT0;
    uint256 public navT1;
    uint256 public finalValue;
    bool public opened;
    bool public finalized;

    event SessionOpened(address indexed vault, uint256 sessionId, uint256 navT0, uint64 at);
    event SessionFinalized(address indexed vault, uint256 navT0, uint256 navT1, uint256 value, uint64 at);

    error NotKeeper();
    error AlreadyOpened();
    error NotOpened();
    error TooEarly();

    constructor(address vault_, uint64 closesAt_, uint256 sessionId_) {
        vault = IBotVault(vault_);
        closesAt = closesAt_;
        sessionId = sessionId_;
        keeper = msg.sender;
    }

    function open() external {
        if (msg.sender != keeper) revert NotKeeper();
        if (opened) revert AlreadyOpened();
        navT0 = vault.nav();
        opened = true;
        emit SessionOpened(address(vault), sessionId, navT0, uint64(block.timestamp));
    }

    /// Permissionless: anyone may freeze the answer once the window has closed.
    /// Call `vault.redeemAll()` first so open positions are already collateral.
    function finalize() external {
        if (!opened) revert NotOpened();
        if (block.timestamp < closesAt) revert TooEarly();
        if (finalized) return;
        navT1 = vault.nav();
        finalValue = navT1 > navT0 ? OUTCOME_YES : OUTCOME_NO;
        finalized = true;
        emit SessionFinalized(address(vault), navT0, navT1, finalValue, uint64(block.timestamp));
    }

    /// The committee's read. Never reverts. 1 or 2 once final, 0 before —
    /// and 0 is outside every registered interval, so it voids rather than lies.
    function outcomeValue() external view returns (uint256) {
        return finalized ? finalValue : 0;
    }

    /// For the UI and for anyone re-deriving the result themselves.
    function state() external view returns (
        uint256 navT0_, uint256 navLive, uint64 closesAt_, bool opened_, bool finalized_, uint256 value
    ) {
        return (navT0, vault.nav(), closesAt, opened, finalized, finalized ? finalValue : 0);
    }
}
