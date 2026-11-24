// Shim for @agentbadge/passport/logger — same public API as the
// monorepo package (JSON-line logger). Satisfies the vendored
// gate code's runtime import; changes no vendored bytes.
// See gate/PROVENANCE.md.

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const env = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const level = ORDER[env] !== undefined ? env : "info";

function emit(l: LogLevel, msg: string, ctx?: Record<string, unknown>) {
  if (ORDER[l] < ORDER[level]) return;
  const line = { ts: new Date().toISOString(), level: l, msg, ...(ctx ? { ctx } : {}) };
  (l === "error" ? console.error : console.log)(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
};
