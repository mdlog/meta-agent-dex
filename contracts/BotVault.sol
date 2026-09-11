// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IERC6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function setOperator(address spender, bool approved) external returns (bool);
    function isOperator(address owner, address spender) external view returns (bool);
}

interface IBinaryPool {
    function placeBinaryOrder(
        uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs,
        uint8 orderType, uint8 selfMatchingOption, address builder,
        uint96 builderFeeBpsTimes1k, uint64 userData
    ) external payable returns (bool success, uint128 id);
}

interface IBinaryModule {
    function markets(bytes32 marketId) external view returns (
        uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy,
        address collateral, uint32 originOperatorId, bytes32 originVenueId,
        address oracleAdapter, address creator, address market, address pool,
        uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry
    );
    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external;
}

/**
 * A segregated trading account for one autonomous agent.
 *
 * The agent's hot key never holds funds — it may only call `trade`, which
 * forwards to DreamDEX. Because the vault is `msg.sender` on the pool, it owns
 * every ERC-6909 outcome position it opens, which is the only way to learn on
 * chain which markets an account touched: ERC-6909 has no enumeration, so a
 * position that the vault did not itself record is a position nobody can find.
 *
 * `protocolCash` is the number the second-layer market settles on. It moves only
 * by collateral deltas measured inside an allowlisted DreamDEX call. That
 * distinction is the whole security model: Shannon's test collateral has a
 * permissionless `faucet(uint256)` with no cooldown and a 10,000-per-call cap, so
 * anyone can push tokens into this contract for the price of gas. Those tokens
 * raise `balanceOf` and change `protocolCash` by exactly nothing, and
 * `unaccounted()` shows the gap to anyone who wants to check.
 *
 * Sessions are closed by `redeemAll`, which is permissionless on purpose. If only
 * the operator could redeem, refusing to would be a free way to hold NAV down
 * after betting against your own agent.
 */
contract BotVault {
    IERC20 public immutable collateral;
    IBinaryModule public immutable module;
    /// One ERC-6909 singleton backs every binary market on this deployment, so a
    /// single grant at construction covers every position the vault will ever
    /// hold. Without it `redeem` reverts InsufficientPermission() and NAV
    /// silently never recovers the winnings — which is exactly what happened
    /// the first time this was tested.
    IERC6909 public immutable outcomeToken;

    address public immutable owner;
    address public operator;

    /// Collateral attributable to DreamDEX activity. NAV is exactly this.
    uint256 public protocolCash;

    uint256 public sessionId;
    uint64 public sessionEnd;
    bool public sessionOpen;

    bytes32[] public touched;
    mapping(bytes32 => bool) public isTouched;

    event OperatorSet(address indexed operator);
    event Deposited(uint256 amount, uint256 protocolCash);
    event Withdrawn(uint256 amount, uint256 protocolCash);
    event SessionOpened(uint256 indexed sessionId, uint64 endsAt, uint256 navT0);
    event Traded(bytes32 indexed marketId, uint8 kind, uint256 price, uint256 quantity, int256 cashDelta);
    event Redeemed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount, int256 cashDelta);
    /// A leg that could not be redeemed. Emitted rather than reverted so one
    /// unsettleable market cannot strand the rest — but never silently, because
    /// a missing redemption understates NAV and the meta-market settles on NAV.
    event RedeemFailed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount);
    event SessionClosed(uint256 indexed sessionId, uint256 navT1);

    error NotOwner();
    error NotOperator();
    error SessionIsOpen();
    error SessionNotOpen();
    error SessionNotEnded();
    error MarketOutlivesSession();
    error NothingToRedeem();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }

    constructor(address collateral_, address module_, address outcomeToken_, address owner_, address operator_) {
        collateral = IERC20(collateral_);
        module = IBinaryModule(module_);
        outcomeToken = IERC6909(outcomeToken_);
        owner = owner_;
        operator = operator_;
        outcomeToken.setOperator(module_, true);
    }

    function setOperator(address operator_) external onlyOwner {
        if (sessionOpen) revert SessionIsOpen();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    // ---- capital, only outside a session ------------------------------------

    function deposit(uint256 amount) external onlyOwner {
        if (sessionOpen) revert SessionIsOpen();
        collateral.transferFrom(msg.sender, address(this), amount);
        protocolCash += amount;
        emit Deposited(amount, protocolCash);
    }

    function withdraw(uint256 amount) external onlyOwner {
        if (sessionOpen) revert SessionIsOpen();
        protocolCash -= amount;
        collateral.transfer(owner, amount);
        emit Withdrawn(amount, protocolCash);
    }

    // ---- session ------------------------------------------------------------

    /**
     * Opening a session COMPACTS the touched list rather than clearing it.
     *
     * Clearing it lost money. A market that expired but whose settlement had not
     * yet landed on chain makes `redeem` revert, `redeemAll` records a
     * RedeemFailed and moves on — and if the next session then wiped the list,
     * that position became unreachable: `redeemAll` iterates `touched`, and
     * ERC-6909 has no enumeration to rediscover it from. Measured on a live
     * agent, which finished a session still holding 17.22 tUSDC of a resolved
     * market it could no longer redeem, and settled its meta-market on the
     * understated number.
     *
     * So entries are dropped only once the vault genuinely holds nothing in
     * them, which bounds the list to positions that are actually stuck.
     */
    function openSession(uint64 endsAt) external onlyOwner {
        if (sessionOpen) revert SessionIsOpen();
        sessionId += 1;
        sessionEnd = endsAt;
        sessionOpen = true;

        uint256 kept = 0;
        uint256 n = touched.length;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 marketId = touched[i];
            (, , , , , , , , , , uint256 yesId, uint256 noId, , ) = module.markets(marketId);
            if (outcomeToken.balanceOf(address(this), yesId) == 0 && outcomeToken.balanceOf(address(this), noId) == 0) {
                isTouched[marketId] = false;
                continue;
            }
            touched[kept] = marketId;
            kept += 1;
        }
        while (touched.length > kept) touched.pop();

        emit SessionOpened(sessionId, endsAt, protocolCash);
    }

    /// The agent's only privilege. Reverts if the market would outlive the
    /// session, which is what keeps every position terminal by `sessionEnd`.
    function trade(
        bytes32 marketId, uint8 kind, uint256 price, uint256 quantity,
        uint64 expireTimestampNs, uint8 orderType
    ) external onlyOperator {
        if (!sessionOpen) revert SessionNotOpen();
        (, , , , , , , , , address pool, , , , uint64 expiry) = module.markets(marketId);
        if (expiry > sessionEnd) revert MarketOutlivesSession();

        if (!isTouched[marketId]) { isTouched[marketId] = true; touched.push(marketId); }

        uint256 before = collateral.balanceOf(address(this));
        collateral.approve(pool, type(uint256).max);
        IBinaryPool(pool).placeBinaryOrder(kind, price, quantity, expireTimestampNs, orderType, 0, address(0), 0, 0);
        int256 delta = _applyDelta(before);
        emit Traded(marketId, kind, price, quantity, delta);
    }

    /// Permissionless. Converts every terminal position back into collateral.
    function redeemAll() external {
        if (!sessionOpen) revert SessionNotOpen();
        if (block.timestamp < sessionEnd) revert SessionNotEnded();

        uint256 n = touched.length;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 marketId = touched[i];
            (, , , , uint32 opId, bytes32 venueId, , , , , uint256 yesId, uint256 noId, , ) =
                module.markets(marketId);

            _redeemLeg(opId, venueId, marketId, 0, outcomeToken.balanceOf(address(this), yesId));
            _redeemLeg(opId, venueId, marketId, 1, outcomeToken.balanceOf(address(this), noId));
        }
    }

    /**
     * Redeem one market on its own, at any time, by anyone.
     *
     * `redeemAll` runs once at close, and a settlement that lands a minute later
     * is not a reason to strand a position. Permissionless because the alternative
     * is an operator who can leave a losing position unredeemed to hold NAV down
     * after betting against their own agent.
     */
    function redeemMarket(bytes32 marketId) external {
        if (!isTouched[marketId]) revert NothingToRedeem();
        (, , , , uint32 opId, bytes32 venueId, , , , , uint256 yesId, uint256 noId, , ) = module.markets(marketId);
        _redeemLeg(opId, venueId, marketId, 0, outcomeToken.balanceOf(address(this), yesId));
        _redeemLeg(opId, venueId, marketId, 1, outcomeToken.balanceOf(address(this), noId));
    }

    function closeSession() external {
        if (!sessionOpen) revert SessionNotOpen();
        if (block.timestamp < sessionEnd) revert SessionNotEnded();
        sessionOpen = false;
        emit SessionClosed(sessionId, protocolCash);
    }

    // ---- views --------------------------------------------------------------

    /// What the second-layer market settles on.
    function nav() external view returns (uint256) { return protocolCash; }

    /// Collateral sitting here that no DreamDEX call delivered. Never counted in
    /// NAV; exposed so the claim can be checked rather than believed.
    function unaccounted() external view returns (uint256) {
        uint256 held = collateral.balanceOf(address(this));
        return held > protocolCash ? held - protocolCash : 0;
    }

    function touchedCount() external view returns (uint256) { return touched.length; }
    function touchedMarkets() external view returns (bytes32[] memory) { return touched; }

    // ---- internals ----------------------------------------------------------

    function _redeemLeg(uint32 opId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = collateral.balanceOf(address(this));
        try module.redeem(opId, venueId, marketId, outcomeIdx, amount) {
            int256 delta = _applyDelta(before);
            emit Redeemed(marketId, outcomeIdx, amount, delta);
        } catch {
            emit RedeemFailed(marketId, outcomeIdx, amount);
        }
    }

    /// Folds the collateral movement caused by the call just made into
    /// `protocolCash`, and returns it for the event log.
    function _applyDelta(uint256 before) private returns (int256 delta) {
        uint256 nowHeld = collateral.balanceOf(address(this));
        if (nowHeld >= before) {
            uint256 gain = nowHeld - before;
            protocolCash += gain;
            delta = int256(gain);
        } else {
            uint256 loss = before - nowHeld;
            protocolCash = protocolCash > loss ? protocolCash - loss : 0;
            delta = -int256(loss);
        }
    }
}
