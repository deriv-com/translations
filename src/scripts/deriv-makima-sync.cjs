#!/usr/bin/env node
"use strict";

/**
 * Retired name of deriv-rosetta-sync. Kept as a bin so `npx deriv-makima-sync`
 * fails with a pointer instead of fetching an unrelated registry package of
 * that name. Remove after Makima's sunset (18 Nov 2026).
 */
if (require.main === module) {
  console.error(
    "✗ deriv-makima-sync is retired: Makima is sunset on 18 Nov 2026. Use deriv-rosetta-sync with ROSETTA_API_TOKEN and ROSETTA_API_BASE (https://translation-api.deriv.ai). See the README section 'Moving from the Makima action'."
  );
  process.exit(1);
}
