'use strict';

require('../ui/desktop/scripts/bundle-macos.cjs').main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
