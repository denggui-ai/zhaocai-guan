'use strict';

const path = require('node:path');
// Source and packaged apps both keep package.json one level above src/.
// Never derive storage roots from cwd or the relocated module directory.
const PROJECT_ROOT = path.resolve(__dirname, '..');
module.exports = { PROJECT_ROOT };
