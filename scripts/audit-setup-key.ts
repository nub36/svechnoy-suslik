/**
 * TASK 11 — AUDIT WHY CURRENT setupKey CHANGES EVERY CANDLE
 * Likely BOS identity using current evaluation timestamp instead of stable event key/confirmedAt
 */

import { readFileSync } from "fs";

console.log("=== SETUP_KEY ROOT CAUSE AUDIT ===");

const setupSrc = readFileSync("lib/signals/setup-key.ts", "utf8");
console.log("\n--- setup-key.ts extractSetupComponents ---");
console.log(setupSrc.slice(0, 2000));

console.log("\n--- Analysis ---");
console.log(`
Root cause why current setupKey = 11 different keys for 08:15..10:45:

1. extractSetupComponents uses:
   - swingBosKey = bosReason?.value || null, where value = "BOS:down" — not unique, but also
   - swingBosConfirmedAt = meta.commonHorizon — commonHorizon changes every candle (H), so even if BOS key same, confirmedAt proxy changes every candle, making tuple different each candle.

2. Similarly swingOrderBlockKey = value = OB key (which is stable), but swingOrderBlockConfirmedAt = meta.commonHorizon — again changes every candle, so even same OB key gives different tuple.

3. Same for fvgKey and fvgConfirmedAt using commonHorizon as proxy.

4. Therefore tuple:
   bos:BOS:down|2026-09-13T08:15:00Z
   bos:BOS:down|2026-09-13T08:30:00Z
   etc — different every candle because commonHorizon is H itself, not BOS confirmedAt.

5. Correct design should use stable event keys and their confirmedAt, not current H:
   - BOS key = structure event key (e.g., SMC1|...), stable until new BOS
   - BOS confirmedAt = event.confirmedAt, stable
   - OB key = OB key stable, confirmedAt = OB confirmedAt stable
   - FVG key stable, confirmedAt stable

6. Since candidate builder does NOT store BOS event key explicitly in metadata, extractSetupComponents cannot get stable key, it uses commonHorizon as fallback, causing every candle to be different.

7. Additionally, rangeKey and sweepKey may change every candle.

8. Score not in key (correct), but timestamp proxy makes key change every candle.

Conclusion:
- Current setupKey design FAILED as dedup because it uses current evaluation timestamp (commonHorizon) instead of stable causal fact timestamps.
- For V1 production dedup, do NOT use current setupKey.
- Use EDGE/RE-ARM state machine instead, which correctly gives 1 unique for 08:15..10:45.

Fixing setupKey secondary, but to fix it properly:
- Need to store in candidate.metadata: latest swing BOS event key and confirmedAt, not just BOS:dir
- Similarly store OB keys with confirmedAt, FVG keys with confirmedAt, sweep keys
- Then setupKey built from those stable keys will be same across 08:15..10:45 if thesis same.

For now, keep setupKey as research metadata, not production emission determinant.
`);

console.log("\n=== END AUDIT ===");
