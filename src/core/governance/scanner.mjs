import { scanEcosystemInventory, clearEcosystemInventoryCache } from '../ecosystem-inventory.mjs';

export { clearEcosystemInventoryCache };

/**
 * Scan the complete Antigravity customization ecosystem and build the Effective Harness Stack (#1).
 * Delegates to the unified `ecosystem-inventory.mjs` base (5s fast-TTL + 15s fingerprint cache).
 */
export function scanEcosystem(params = {}, options = {}) {
  return scanEcosystemInventory(params, options);
}
