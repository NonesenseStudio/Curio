import { createHash } from "node:crypto";

/**
 * Bump when sanitization or anchor rules change in body-pipeline. Older
 * versions remain readable only while listed in LEGACY_SANITIZE_VERSIONS.
 * Kept separate so the server pipeline and persistence layer share it.
 */
export const SANITIZE_VERSION = "sb2";
/** Previously sanitized bodies remain safe and readable across this migration. */
export const LEGACY_SANITIZE_VERSIONS = ["sb1"] as const;

export function digest12(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
