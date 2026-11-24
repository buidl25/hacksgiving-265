#!/usr/bin/env bun
// agent — the Thanksgiving shopper loop. The brain is pluggable:
//   AGENT_BRAIN=ollama (default; local model inside the sprite)
//   AGENT_BRAIN=claude|codex (stock CLI, if a key is present)
// Deterministic parts (arithmetic, gate calls, retries) live here;
// the LLM only picks carts and replans — real choices, real DENY.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const HERE = new URL(".", import.meta.url).pathname;
const CLIENT = `${HERE}gate-client.sh`;
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:1b";
const BRAIN = process.env.AGENT_BRAIN ?? "ollama";
const MAX_ROUNDS = 4;

/* ------------------------------- brain -------------------------------- */

async function brain(prompt: string, json = true): Promise<string> {
  if (BRAIN === "ollama") {
    const r = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, prompt, stream: false,
        ...(json ? { format: "json" } : {}),
        options: { temperature: 0.2, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return ((await r.json()) as { response: string }).response;
  }
  // stock-CLI path — used only when a key is present (AGENT_BRAIN env)
  const cmd = BRAIN === "claude" ? `claude -p` : `codex exec -`;
  const out = execSync(cmd, {
    input: prompt, encoding: "utf8", timeout: 180_000,
    env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
  });
  return out;
}

const extractJson = (s: string): any => {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("brain: no JSON in reply");
  return JSON.parse(m[0]);
};

/* ------------------------------- gate --------------------------------- */

const sh = (args: string) =>
  execSync(`bash ${CLIENT} ${args}`, { encoding: "utf8" });
const shMaybe = (args: string) => {
  try { return { ok: true, out: sh(args) }; }
  catch (e: any) { return { ok: false, out: e.stdout ?? String(e) }; }
};

/* -------------------------------- task --------------------------------- */

const task = readFileSync(`${HERE}task.md`, "utf8");
const mandate = JSON.parse(sh("mandate"));
const catalog = JSON.parse(execSync(`cat ${HERE}catalog.json`, "utf8"));
const budget: number = mandate.caps.dailyUsd;
// 1B models emit "Turkey" / "Pumpkin Pie" — normalize name or sku → sku
const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const skuOf = (k: string) =>
  catalog.items.find((i: any) => norm(i.sku) === norm(k) || norm(i.name) === norm(k))?.sku;
const price = (sku: string) => catalog.items.find((i: any) => i.sku === sku)?.priceUsd;
const cartTotal = (skus: string[]) =>
  Math.round(skus.reduce((s, k) => s + (price(k) ?? 0), 0) * 100) / 100;
const itemsJson = (skus: string[]) =>
  JSON.stringify(skus.map((k) => ({ sku: k, priceUsd: price(k) })));

console.log(`== agent start ==  brain=${BRAIN} model=${MODEL} budget=$${budget}`);
console.log(`mandate: ${JSON.stringify(mandate.caps)} vendors=${mandate.allowedVendors}`);

let denied: { reason: string; used?: number; limit?: number } | null = null;
let lastCart: string[] = [];

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const prompt = denied
    ? `${task}\nYour cart ${JSON.stringify(lastCart)} ($${cartTotal(lastCart)}) was DENIED by the spend gate: ${denied.reason} (already spent today: $${denied.used ?? 0}, daily limit: $${denied.limit}). Pick a SMALLER cart that fits the remaining budget. Reply JSON only: {"items":["sku",...],"why":"short"}`
    : `${task}\nCatalog: ${JSON.stringify(catalog.items)}\nDaily budget: $${budget}. Pick the items to buy. Reply JSON only, using the lowercase sku values: {"items":["turkey","gravy",...],"why":"short"}`;

  console.log(`\n-- round ${round} -- brain thinking…`);
  const reply = await brain(prompt);
  let skus: string[];
  try {
    const j = extractJson(reply);
    skus = [...new Set(((j.items as string[]) ?? []).map(skuOf).filter(Boolean) as string[])];
  } catch (e) {
    console.log(`brain returned unparseable: ${reply.slice(0, 160)}`);
    continue;
  }
  if (!skus.length) { console.log("empty cart, retrying"); continue; }
  lastCart = skus;
  const total = cartTotal(skus);
  console.log(`cart: ${skus.join(", ")} = $${total}`);

  const res = shMaybe(`buy ${total} '${itemsJson(skus)}'`);
  console.log(res.out.trim());
  const parsed = (() => { try { return JSON.parse(res.out); } catch { return null; } })();

  if (parsed?.verdict === "DENY") {
    denied = { reason: parsed.reason, used: parsed.deny?.used, limit: parsed.deny?.limit };
    console.log(`gate: DENY ${parsed.reason} (used=$${denied.used}/limit=$${denied.limit}) — replanning…`);
    continue;
  }
  if (parsed?.executed && parsed?.receipt) {
    console.log(`\n== PURCHASED == tx=${parsed.receipt.txId} amount=$${parsed.receipt.amountUsd} shopBalance=$${parsed.receipt.balanceAfterUsd}`);
    break;
  }
  console.log("unexpected gate reply — aborting");
  process.exit(2);
}

console.log("\n== audit trail ==");
console.log(sh("audit"));
