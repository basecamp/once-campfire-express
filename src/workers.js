import { availableParallelism } from "node:os";

export function parseWebWorkers(
  value = process.env.WEB_WORKERS,
  available = availableParallelism(),
) {
  const raw =
    value === undefined || value === "" ? "auto" : String(value).trim();
  if (raw === "auto") return Math.min(64, Math.max(1, available));
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 64)
    throw new Error("WEB_WORKERS must be 'auto' or between 1 and 64");
  return count;
}
