const {spawnSync}=require('node:child_process');
const result=spawnSync(process.execPath,['--import','tsx','--test','tests/businessRules.test.ts'],{stdio:'inherit',env:{...process.env,PV_TEST_HTTP:'1'},windowsHide:true});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;
