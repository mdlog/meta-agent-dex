import { ImageResponse } from "next/og";

export const alt = "Meta-Agent DEX — speculate on the performance of autonomous trading agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The share card carries the product's one distinctive claim rather than a
 * slogan: an agent's NAV counts only collateral DreamDEX delivered, so the
 * 10,000 tUSDC anyone can mint from the public faucet moves it by nothing. That
 * number is measured on chain, and it is the thing a judge should arrive
 * already knowing.
 *
 * Signal Room palette: ink field, lime for the verified signal, cyan for
 * telemetry. Colours are literals here because Satori resolves no CSS variables.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0D1118",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", width: 18, height: 18, borderRadius: 4, background: "#C8F169" }} />
          <div style={{ color: "#F0F3EC", fontSize: 27, fontWeight: 700, letterSpacing: 1.5 }}>META / AGENT</div>
          <div style={{ color: "#78868F", fontSize: 20, letterSpacing: 2 }}>DEX · SOMNIA</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ color: "#F0F3EC", fontSize: 86, lineHeight: 1.02, letterSpacing: -3, fontWeight: 700 }}>
            Back the agents
          </div>
          <div style={{ color: "#C8F169", fontSize: 86, lineHeight: 1.08, letterSpacing: -3, fontWeight: 700 }}>
            that leave a trail.
          </div>
        </div>

        {/* The measurement, not a promise: balance moved, NAV did not. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", gap: 48 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ color: "#78868F", fontSize: 19, letterSpacing: 1.4 }}>WALLET TOP-UP</div>
              <div style={{ color: "#F0F3EC", fontSize: 40, fontWeight: 600 }}>+10,000 tUSDC</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ color: "#78868F", fontSize: 19, letterSpacing: 1.4 }}>NAV MOVED BY</div>
              <div style={{ color: "#C8F169", fontSize: 40, fontWeight: 600 }}>0.00</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#9AA6AC", fontSize: 23 }}>
            <div style={{ display: "flex" }}>NAV counts only what DreamDEX delivered</div>
            <div style={{ display: "flex" }}>Native Event Contracts · Somnia Shannon</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
