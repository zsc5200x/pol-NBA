import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { inspectCapture,summarizeCaptures } from '../src/crown/captures.mjs';
try {
 const observations=[];let output;
 for(let i=2;i<process.argv.length;i+=2){const flag=process.argv[i],file=process.argv[i+1];if(!file)throw Error();if(flag==='--output'){output=resolve(file);continue;}const source={'--today':'today','--early':'early','--more':'detail'}[flag];if(!source)throw Error();observations.push(inspectCapture(await readFile(file,'utf8'),source));}
 if(!observations.length)throw Error();const report=summarizeCaptures(observations);const json=JSON.stringify(report,null,2)+'\n';
 if(output){await mkdir(dirname(output),{recursive:true,mode:0o700});await writeFile(output,json,{mode:0o600});}
 console.log(JSON.stringify({mode:report.mode,uniqueMatches:report.uniqueMatches,captures:observations.map(o=>({kind:o.kind,reportedSource:o.reportedSource,responseMode:o.responseMode,sourceConflict:o.sourceConflict,outerJson:o.outerJson,embeddedOriginal:o.embeddedOriginal,nbaRecords:o.nbaRecords,childRecords:o.childRecords,families:o.families?.map(f=>({familyId:f.familyId,records:f.childGids.length,observedLineValues:f.observedLineValues,nonzeroMoneylineRecords:f.nonzeroMoneylineRecords}))})),liveVerified:false,fullCoverageVerified:false},null,2));
} catch { console.error('样本检查失败：请提供有效的历史响应文件路径。不会输出文件正文或任何会话值。');process.exitCode=1; }
