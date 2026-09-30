'use strict';

if (process.platform !== 'darwin') {
  console.error('PDF 测评本地试点启动命令当前只支持 macOS。');
  process.exit(1);
}

process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '1';
require('./start-candidate-ui');
