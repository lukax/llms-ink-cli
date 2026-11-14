import {constants} from 'node:fs';
import {lstat,open,realpath,link,unlink} from 'node:fs/promises';
import {dirname,join,relative,resolve,isAbsolute,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {prepareInspection,inspectionJson,inspectionReceipt} from './inspect-contract.js';

const ENDPOINT='https://llms.ink';
const MAX=131072;
const HELP=`Usage: llms-ink inspect --file <path> [-o receipt.json]

Explicitly upload one UTF-8 .txt, .md or .json file to the hosted Inspect pilot.
Paths must be inside the current folder. Symlinks, globs and stdin are refused.
JSON files are inspected as exact text, including whitespace; no reserialization.

  --file <path>       required input; at most 128 KiB after request encoding
  -o, --output <p>    write metadata-only receipt without overwriting; default stdout
  --json             accepted for scripting; output is always receipt JSON
  --quiet            suppress the result summary on stderr
  -h, --help         show this help

Set LLMS_INK_INSPECT_KEY (or LLMS_INK_KEY) to an inspection-enabled key.
LLMS_INK_API and --api cannot redirect inspection credentials. No automatic retries.
0 = complete/no finding; 1 = flagged, incomplete or failed; 2 = invalid input/setup.
A receipt is unsigned and not a safety guarantee. Changed bytes need another scan.
Pilot details: https://llms.ink/inspect/
`;
class InputError extends Error {}

async function localPath(root,path) {
  if(!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p=>p==='..'||p==='.git') || /[*?\[\]]/.test(path)) throw new InputError('Use an explicit relative path inside the current folder.');
  const target=resolve(root,path), rel=relative(root,target);
  if(!rel || rel.startsWith('..'+sep) || isAbsolute(rel)) throw new InputError('Path is outside the current folder.');
  let parent=root;
  for(const part of rel.split(sep).slice(0,-1)) { parent=join(parent,part); const stat=await lstat(parent); if(stat.isSymbolicLink()||!stat.isDirectory()) throw new InputError('Path parents must be existing directories, without symlinks.'); }
  if(await realpath(dirname(target))!==dirname(target)) throw new InputError('Path changed during validation.');
  return target;
}
async function readInput(root,path) {
  if(!/\.(md|txt|json)$/i.test(path)) throw new InputError('Choose a .md, .txt or .json file.');
  const target=await localPath(root,path), before=await lstat(target);
  if(!before.isFile()||before.isSymbolicLink()||before.size>MAX) throw new InputError('Input must be a regular file no larger than 128 KiB, without symlinks.');
  const handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try {
    const start=await handle.stat(); if(!start.isFile()||start.ino!==before.ino||start.dev!==before.dev) throw new InputError('Input changed during validation.');
    const buffer=Buffer.alloc(MAX+1);let count=0;
    while(count<buffer.length){const r=await handle.read(buffer,count,buffer.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}
    const end=await handle.stat(),current=await lstat(target);
    if(count>MAX||end.size!==start.size||end.mtimeMs!==start.mtimeMs||end.ctimeMs!==start.ctimeMs||current.ino!==start.ino||current.dev!==start.dev||await realpath(target)!==target)throw new InputError('Input is too large or changed during reading.');
    try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,count));}catch{throw new InputError('Input must be valid UTF-8.');}
  }finally{await handle.close();}
}

export async function cmdInspect(argv,{env,stdout,stderr,cwd,fetch,signal}) {
  let temp, handle;
  try {
    let parsed;
    try{parsed=parseArgs({args:argv,allowPositionals:false,options:{file:{type:'string'},output:{type:'string',short:'o'},json:{type:'boolean'},quiet:{type:'boolean'},help:{type:'boolean',short:'h'}}});}catch{throw new InputError('Invalid inspect options. Run llms-ink inspect --help.');}
    const v=parsed.values;
    if(v.help){stdout.write(HELP);return 0;}
    if(!v.file)throw new InputError('Specify --file. Nothing is uploaded by default.');
    const key=(env.LLMS_INK_INSPECT_KEY??env.LLMS_INK_KEY??'').trim();
    if(!/^lk_[A-Za-z0-9]{32}$/.test(key))throw new InputError('Set LLMS_INK_INSPECT_KEY to an inspection-enabled key.');
    const root=await realpath(cwd);
    let dest;
    if(v.output && v.output!=='-'){
      dest=await localPath(root,v.output);
      try{await lstat(dest);throw new InputError('Output already exists. Choose a new receipt path.');}catch(e){if(e.code!=='ENOENT')throw e;}
      temp=join(dirname(dest),'.llms-inspect-'+randomUUID()+'.tmp');
      handle=await open(temp,'wx',0o600);
    }
    const text=await readInput(root,v.file);
    let prepared;
    try{prepared=await prepareInspection(text,ENDPOINT);}catch{throw new InputError('Input is empty, invalid Unicode, or exceeds 128 KiB after JSON encoding.');}
    const controller=new AbortController(),abort=()=>controller.abort();
    const timer=setTimeout(abort,65000);
    if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
    let receipt;
    try{
      const res=await fetch(ENDPOINT+'/api/v0/inspect',{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:'application/json'},body:prepared.body});
      const value=await inspectionJson(res);
      // Never include remote error text: it may contain the source, credentials or control sequences.
      if(![200,422,503].includes(res.status)||!value||typeof value!=='object'||!('detection'in value)){
        const retry=res.headers.get('retry-after');
        stderr.write(`llms-ink: Inspection failed (HTTP ${res.status}). Withhold the content.${/^\d{1,6}$/.test(retry??'')?` Retry after ${retry} seconds.`:''}\n`);return 1;
      }
      receipt=inspectionReceipt(value,prepared.digest,res.status);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    const json=JSON.stringify(receipt,null,2)+'\n';
    if(dest){await handle.writeFile(json);await handle.sync();await handle.close();handle=undefined;await link(temp,dest);}
    else stdout.write(json);
    if(!v.quiet)stderr.write(`Inspect: ${receipt.detection}; ${receipt.coverage} coverage; ${receipt.recommendation}.\n`);
    return receipt.recommendation==='continue'?0:1;
  }catch(e){
    if(e instanceof InputError){stderr.write('llms-ink: '+e.message+'\n');return 2;}
    if(['ENOENT','EISDIR','EACCES','ELOOP','ENOTDIR'].includes(e?.code)){stderr.write('llms-ink: Cannot read input or create output. Check paths and permissions.\n');return 2;}
    stderr.write('llms-ink: Inspection did not complete or its receipt was invalid. Withhold the content.\n');return 1;
  }finally{await handle?.close().catch(()=>{});if(temp)await unlink(temp).catch(()=>{});}
}
