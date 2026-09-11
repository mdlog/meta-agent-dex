/**
 * Read `.env` from this directory, not from the repo root.
 *
 * The example is meant to be copied out of this repo and run on its own, so it
 * never reaches for the arena's own `.env.local` — a file whose keys control the
 * demo fleet's vaults. Whatever you put here belongs to you.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const file = path.join(HERE, ".env");
const parsed: Record<string, string> = {};
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

/** `process.env` wins, so `FOO=bar npm run …` overrides the file. */
export function env(name: string): string | undefined {
  const v = process.env[name] ?? parsed[name];
  return v === "" ? undefined : v;
}

export function need(name: string, hint: string): string {
  const v = env(name);
  if (v === undefined) {
    console.error(`\n${name} is not set.\n  ${hint}\n`);
    process.exit(1);
  }
  return v;
}

export function num(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`\n${name} must be a number, got "${v}".\n`);
    process.exit(1);
  }
  return n;
}

export function big(name: string, fallback: bigint): bigint {
  const v = env(name);
  if (v === undefined) return fallback;
  try {
    return BigInt(v);
  } catch {
    console.error(`\n${name} must be a whole number, got "${v}".\n`);
    process.exit(1);
  }
}

export function hexKey(name: string, hint: string): `0x${string}` {
  const raw = need(name, hint);
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error(`\n${name} is not a 32-byte hex private key.\n  ${hint}\n`);
    process.exit(1);
  }
  return key as `0x${string}`;
}

/** Shannon addresses. Constants, not configuration — they are the venue. */
export const SHANNON = {
  rpc: env("SOMNIA_RPC_URL") ?? "https://dream-rpc.somnia.network",
  indexer: env("SOMNIA_INDEXER_URL") ?? "https://dev.smk.somnia.host/v1/graphql",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as const,
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388" as const,
  outcomeToken: "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9" as const,
} as const;

export const ARENA = (env("ARENA_API") ?? "https://meta-agent.mdloglabs.org").replace(/\/+$/, "");
