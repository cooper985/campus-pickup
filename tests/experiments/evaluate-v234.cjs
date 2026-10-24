// Offline comparison. Each engine loads a complete service snapshot; no cloud calls or real storage writes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { inventory, read, cacheFile } = require('../live-ocr/run.cjs');
const { page } = require('../helpers/page');
const { fakeStorage } = require('../helpers/storage');
const root = path.resolve(__dirname, '../..'), baseline = '2329778';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-v234-baseline-'));
const normalize = s => String(s || '').normalize('NFKC').replace(/\s/g,'');
const expected = [['127-3-5016','河工大洗浴中心北侧菜鸟驿站'],['87-6-4601','河工大31号楼500以上在钟楼'],['313-3-3308','河工大31号楼500以上在钟楼']];
function engine(dir) {
  const services = {};
  for (const file of fs.readdirSync(path.join(dir,'miniprogram/services'))) if (file.endsWith('.js') && !/^(fileid|cloud|mock)-ocr/.test(file)) services[file.slice(0,-3)] = require(path.join(dir,'miniprogram/services',file));
  return { services, parser: services['pickup-parser'], source: fs.readFileSync(path.join(dir,'miniprogram/pages/pickup/index.js'),'utf8') };
}
function corpus(e,samples) {
  let missing = 0, falseCandidates = 0, wrongLocations = 0, expectedCodes = 0;
  for (const s of samples) {
    const records = e.parser.parse(s.result.lines,0,s.result.boxes), remaining = s.expected.map(([code]) => normalize(code));
    expectedCodes += s.expected.length;
    for (const [code,station] of s.expected) {
      const found = records.find(r => normalize(r.code) === normalize(code));
      if (!found) missing++; else if (normalize(found.station) !== normalize(station)) wrongLocations++;
    }
    for (const r of records) {const i=remaining.indexOf(normalize(r.code));if(i<0)falseCandidates++;else remaining.splice(i,1);}
  }
  return { images: samples.length, expectedCodes, missing, falseCandidates, wrongLocations };
}
async function simulate(e,samples) {
  const api = fakeStorage();
  api.getFileInfo = ({filePath,success}) => success({digest:String(samples.findIndex(s=>s.id===filePath)+1).padStart(40,'0'),size:100});
  const p = page(api, async id => samples.find(s=>s.id===id).result, e.source, e.services);
  p.data.images = samples.map(s=>s.id); await p.recognizeCloud();
  const b = p.importState.batches[0];
  const result = { records:p.data.records.map(r=>({code:r.code,station:r.station})), exceptions:b.reviews.length, fusedSources:b.fusedSources||0,
    stations:p.stationState.groups.map(g=>({name:g.name,discoveryStatus:g.discoveryStatus||'legacy'})),
    outcomes:b.outcomes.map(o=>({decision:o.decision,reason:o.reason})) };
  const expectedParcels = new Map(samples.flatMap(s => s.expected));
  const expectedStations = new Set(expectedParcels.values());
  const all = samples.flatMap((s,sourceIndex) => e.parser.parse(s.result.lines,sourceIndex,s.result.boxes).map((c,i) => ({...c,id:sourceIndex+':'+i})));
  const byId = new Map(all.map(c=>[c.id,c.code]));
  const fused = e.services['candidate-fusion'].fuse(all);
  result.metrics = {
    missingParcels: [...expectedParcels.keys()].filter(code=>!result.records.some(r=>r.code===code)).length,
    wrongMerges: fused.filter(c=>new Set((c.sourceIds||[c.id]).map(id=>byId.get(id))).size>1).length,
    wrongLocationAssignments: result.records.filter(r=>expectedParcels.get(r.code)!==r.station).length,
    unnecessaryReviews: result.exceptions,
    unexpectedStationMemories: result.stations.filter(g=>!expectedStations.has(g.name)).length
  };
  p.onUnload();return result;
}
function synthetic(e) {
  let wrongMerges=0,missingParcels=0,unnecessaryReviews=0;
  const fixtures=require('../fixtures/v23-labeled-batches.json');
  for(const s of fixtures.batches) {
    const byId=new Map(s.candidates.map(c=>[c.id,c.label]));
    const candidates=s.candidates.map(({label,...c},i)=>({...c,sourceIndex:i}));
    const originals=s.records.map(r=>{let x=e.services['pickup-store'].newRecord(r);return r.taken?e.services['pickup-store'].updateRecord(x,{taken:true}):x;});
    const plan=e.services['import-decision'].evaluate(e.services['candidate-fusion'].fuse(candidates),originals,undefined,new Date(2026,9,24,12).getTime());
    const covered=new Set();
    for(const d of plan.decisions) {
      const labels=(d.candidate.sourceIds||[d.candidate.id]).map(id=>byId.get(id));
      wrongMerges+=new Set(labels.map(l=>l.parcelId)).size>1;
      unnecessaryReviews+=d.decision==='NEEDS_REVIEW'&&labels.every(l=>l.decision==='AUTO_IMPORT');
      if(d.decision!=='AUTO_SKIP') labels.forEach(l=>covered.add(l.parcelId));
    }
    missingParcels+=new Set(s.candidates.filter(c=>c.label.decision!=='AUTO_SKIP'&&!covered.has(c.label.parcelId)).map(c=>c.label.parcelId)).size;
  }
  return {type:'synthetic',batches:fixtures.batches.length,wrongMerges,missingParcels,unnecessaryReviews};
}
(async()=>{
  const files=execFileSync('git',['ls-tree','-r','--name-only',baseline,'miniprogram/services','miniprogram/pages/pickup/index.js'],{cwd:root,encoding:'utf8'}).trim().split('\n');
  for(const file of files){const out=path.join(temp,file);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,execFileSync('git',['show',`${baseline}:${file}`],{cwd:root}));}
  const engines={old:engine(temp),current:engine(root)};
  const tencent=inventory().filter(s=>s.expected&&!s.control&&fs.existsSync(cacheFile(s.hash))).map(s=>({...s,result:read(cacheFile(s.hash)).result}));
  const two={id:'real-tencent-two',expected:expected.slice(1),result:read(cacheFile('3e4d26668a0b65a6bf44c0825a7b80f9ce1f3314529fa02b5439918606bf59af')).result};
  tencent.push(two);
  const rapid=require('../fixtures/v233-image-labels.json').filter(s=>['A','B','C'].includes(s.id)).map(s=>({...s,result:read(path.join(root,`test-data/private/v233/rapid-${s.id}-full.json`)).result}));
  const three={id:'real-rapid-three',expected,result:read(path.join(root,'test-data/private/v234/rapid-three-full.json')).result};rapid.push(three);
  const one=tencent.find(s=>s.id==='live-ocr-20261023:arrival-age');
  const detail=tencent.find(s=>s.id==='cainiao-real-ocr-20261022:detail');
  const report={baseline,date:'2026-10-24',additionalCloudCalls:0,engines:{},cases:[],limits:['Three-parcel original exists; its historical Tencent response is unavailable. RapidOCR is separate offline evidence.','Counters cover only labelled samples, not population recognition accuracy.','Actual Android behavior and production OCR response remain unverified.']};
  for(const [name,e]of Object.entries(engines)) report.engines[name]={tencent:corpus(e,tencent),rapid:corpus(e,rapid),synthetic:synthetic(e)};
  for(const [name,samples]of [['Tencent same-station two',[two]],['Tencent three across images plus duplicate detail',[one,two,detail]],['RapidOCR original three in one image',[three]]]) {
    const row={name,results:{}};
    for(const [key,e]of Object.entries(engines)) {
      row.results[key]={parsed:samples.map(s=>({id:s.id,records:e.parser.parse(s.result.lines,0,s.result.boxes).map(r=>({code:r.code,station:r.station})),target313:e.services['recognition-diagnostics'].analyze(s.result.lines,0,s.result.boxes,[expected[2]]).diagnostics.failures[0].stage})),final:await simulate(e,samples)};
    }
    report.cases.push(row);
  }
  // Notifications below are synthetic; they are not labelled as OCR from the original image.
  const notice='【菜鸟】已到'+expected[0][1]+'尽早取，取件码127-3-5016';
  report.syntheticBoundary=Object.fromEntries(Object.entries(engines).map(([name,e])=>[name,e.services['notification-parser'].parse(notice)[0].station]));
  console.log(JSON.stringify(report,null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(err=>{console.error(err.message);process.exitCode=1;});
