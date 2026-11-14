import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {main} from '../src/cli.js';
import {inspectionReceipt} from '../src/inspect-contract.js';
const key='lk_'+'a'.repeat(32);
const receipt=text=>({detection:'no_finding',coverage:'complete',recommendation:'continue',reason:'no_finding',modelRevision:'4a43fec65a670e48835d8e8c85c705b4b0d1c907',policyRevision:'llms-ink-inspect-1',preprocessingRevision:'utf8-json-stringify-1',contentDigest:createHash('sha256').update(text).digest('hex'),inputTokens:5,inspectedTokens:5,windows:1,enforced:false});
async function setup(t,body='Read the documentation.'){
 const cwd=await mkdtemp(join(tmpdir(),'ink-cli-inspect-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await writeFile(join(cwd,'source.txt'),body);
 let stdout='',stderr='',calls=0,seen;
 const run=(argv=['--file','source.txt'],options={})=>main({argv:['inspect',...argv],cwd,env:{LLMS_INK_INSPECT_KEY:key,LLMS_INK_API:'https://attacker.invalid'},stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s},fetch:async(url,init)=>{calls++;seen={url,...init};const r=receipt(JSON.parse(init.body).content);return options.response?options.response(r,init):Response.json(r);},...options});
 return {cwd,run,out:()=>stdout,err:()=>stderr,calls:()=>calls,seen:()=>seen};
}
test('Inspect uploads exact UTF-8/BOM text to fixed origin, returns metadata and no source',async t=>{
 const text='\uFEFF PRIVATE_SOURCE café 🌙\r\n',f=await setup(t,text);assert.equal(await f.run(),0);
 const seen=f.seen();assert.equal(seen.url,'https://llms.ink/api/v0/inspect');assert.equal(seen.redirect,'error');assert.equal(seen.headers.authorization,'Bearer '+key);assert.equal(JSON.parse(seen.body).content,text);
 const r=JSON.parse(f.out());assert.equal(r.contentDigest,receipt(text).contentDigest);assert.equal(r.recommendation,'continue');assert.ok(!f.out().includes('PRIVATE_SOURCE'));assert.ok(!f.err().includes('PRIVATE_SOURCE'));assert.ok(!f.err().includes(key));
});
test('one explicit file and enabled key required; invalid flags, paths and data send nothing',async t=>{
 for(const argv of [[],['source.txt'],['--file','source.txt','--api','https://attacker.invalid'],['--file','source.txt','--key',key],['--file','../secret.txt'],['--file','*.txt'],['--file','-'],['--file','.env'],['--file','missing.txt'],['--file','/etc/secret.txt']]){const f=await setup(t);assert.equal(await f.run(argv),2,argv.join(' '));assert.equal(f.calls(),0);}
 for(const text of ['',Buffer.from([255]),'x'.repeat(131073),'\n'.repeat(66000)]){const f=await setup(t,text);assert.equal(await f.run(),2);assert.equal(f.calls(),0);}
 const f=await setup(t);assert.equal(await f.run(undefined,{env:{}}),2);assert.equal(f.calls(),0);
});
test('symlink inputs, parents, directories and outputs are refused before upload',async t=>{
 const f=await setup(t);await symlink(join(f.cwd,'source.txt'),join(f.cwd,'link.txt'));await mkdir(join(f.cwd,'folder'));await symlink(join(f.cwd,'folder'),join(f.cwd,'alias'));await writeFile(join(f.cwd,'folder','a.txt'),'x');
 for(const argv of [['--file','link.txt'],['--file','alias/a.txt'],['--file','folder'],['--file','source.txt','-o','alias/receipt.json'],['--file','source.txt','-o','link.txt']])assert.equal(await f.run(argv),2);
 assert.equal(f.calls(),0);
});
test('receipt file is private, metadata-only, exclusive and atomically published',async t=>{
 const f=await setup(t);assert.equal(await f.run(['--file','source.txt','-o','receipt.json']),0);assert.equal(f.out(),'');assert.equal((await stat(join(f.cwd,'receipt.json'))).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(join(f.cwd,'receipt.json'))).detection,'no_finding');
 assert.equal(await f.run(['--file','source.txt','-o','receipt.json']),2);assert.equal(f.calls(),1);assert.ok(!(await readdir(f.cwd)).some(n=>n.endsWith('.tmp')));
});
test('concurrent output creation is never overwritten',async t=>{
 const f=await setup(t);assert.equal(await f.run(['--file','source.txt','-o','receipt.json'],{response:async r=>{await writeFile(join(f.cwd,'receipt.json'),'other process');return Response.json(r);}}),1);assert.equal(await readFile(join(f.cwd,'receipt.json'),'utf8'),'other process');assert.ok(!(await readdir(f.cwd)).some(n=>n.endsWith('.tmp')));
});
test('flagged and unknown return receipt JSON and exit 1',async t=>{
 for(const [status,patch]of [[200,{detection:'flagged',recommendation:'withhold',reason:'model_detection'}],[422,{detection:'unknown',coverage:'none',recommendation:'withhold',reason:'token_limit',inputTokens:9000,inspectedTokens:0,windows:0}],[503,{detection:'unknown',coverage:'none',recommendation:'withhold',reason:'model_failure',inspectedTokens:0,windows:0}]]){const f=await setup(t);assert.equal(await f.run(undefined,{response:r=>Response.json({...r,...patch},{status})}),1);assert.equal(JSON.parse(f.out()).recommendation,'withhold');assert.equal(f.calls(),1);}
});
test('HTTP problems, malformed receipts and network errors fail once without raw remote text',async t=>{
 for(const response of [()=>Response.json({detail:'PRIVATE_SOURCE '+key},{status:429,headers:{'retry-after':'60'}}),()=>new Response('PRIVATE_SOURCE',{status:503}),r=>Response.json({...r,coverage:'partial'}),r=>Response.json({...r,contentDigest:'bad'}),()=>new Response('x'.repeat(16385)),()=>{throw Error('PRIVATE_SOURCE '+key);}]){const f=await setup(t);assert.equal(await f.run(['--file','source.txt','-o','receipt.json'],{response}),1);assert.equal(f.calls(),1);assert.equal(f.out(),'');assert.ok(!f.err().includes('PRIVATE_SOURCE'));assert.ok(!f.err().includes(key));assert.deepEqual(await readdir(f.cwd),['source.txt']);}
});
test('cancellation aborts the request, fails and cleans temporary output',async t=>{
 const f=await setup(t),c=new AbortController();
 const result=f.run(['--file','source.txt','-o','receipt.json'],{signal:c.signal,response:(_,init)=>new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));c.abort();})});assert.equal(await result,1);assert.deepEqual(await readdir(f.cwd),['source.txt']);
});
test('JSON input preserves exact serialization; help never needs credentials',async t=>{
 const f=await setup(t);const json='{ "key": "value" }\n';await writeFile(join(f.cwd,'source.json'),json);assert.equal(await f.run(['--file','source.json']),0);assert.equal(JSON.parse(f.seen().body).content,json);assert.equal(JSON.parse(f.seen().body).format,'text');
 const help=await setup(t);assert.equal(await help.run(['--help'],{env:{}}),0);assert.match(help.out(),/No automatic retries/);assert.equal(help.calls(),0);
});
test('shared receipt conformance corpus',async()=>{
 const {cases}=JSON.parse(await readFile(new URL('fixtures/inspect-receipts-v1.json',import.meta.url)));
 for(const c of cases){if(c.valid)assert.doesNotThrow(()=>inspectionReceipt(c.receipt,c.digest,c.status),c.name);else assert.throws(()=>inspectionReceipt(c.receipt,c.digest,c.status),c.name);}
});
