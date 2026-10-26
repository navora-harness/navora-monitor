// Metadata benchmark only; does not simulate camera decoding or disk throughput.
import { build } from 'esbuild'
import { performance } from 'node:perf_hooks'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root=resolve(import.meta.dirname,'..')
const bundled=await build({entryPoints:[resolve(root,'shared/timeline-index.ts')],bundle:true,write:false,format:'esm',platform:'node'})
const {createTimelineIndex}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const results=[]
for(const count of [10_000,100_000]) {
  const segments=Array.from({length:count},(_,i)=>({start:i*300_000,end:i*300_000+300_000+(i%13===0?600_000:0)}))
  const start=performance.now()
  const index=createTimelineIndex(segments,s=>s.start,s=>s.end)
  const buildMs=performance.now()-start
  const indexed=[],linear=[]
  for(let sample=0;sample<1000;sample++) {
    const from=(sample*7919%count)*300_000,to=from+3_600_000
    let at=performance.now()
    const visible=index.query(from,to)
    indexed.push(performance.now()-at)
    at=performance.now()
    const baseline=segments.filter(s=>s.start<=to&&s.end>=from)
    linear.push(performance.now()-at)
    if(visible.length!==baseline.length||visible.some((v,i)=>v.item!==baseline[i])) throw Error('Interval search mismatch')
  }
  const percentile=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length*.95)]
  results.push({segments:count,queries:1000,buildMs,indexedP95Ms:percentile(indexed),linearP95Ms:percentile(linear)})
}
await mkdir(resolve(root,'release'),{recursive:true})
const report={scope:'Synthetic metadata only; not a camera or hard-disk benchmark',results}
await writeFile(resolve(root,'release/performance-0.4.1.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
