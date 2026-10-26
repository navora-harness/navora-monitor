import { describe, expect, it } from 'vitest'
import { compactTimelineSpans, createTimelineIndex } from './timeline-index'

describe('timeline interval index', () => {
  it('compacts dense clips while preserving gaps, active clips and exact hit tests', () => {
    const items=Array.from({length:10_000},(_,id)=>({id,a:id*1000,b:(id+1)*1000}))
    const index=createTimelineIndex(items,x=>x.a,x=>x.b)
    const compact=compactTimelineSpans(index.spans,.0001,x=>x.id===5000,()=>true)
    expect(compact.length).toBeLessThan(100)
    expect(compact.filter(x=>x.selected)).toHaveLength(1)
    expect(compact.reduce((n,x)=>n+x.count,0)).toBe(10_000)
    expect(index.query(5_000_500,5_000_500)[0]?.item.id).toBe(5000)
    const gapped=createTimelineIndex([{a:0,b:1},{a:2,b:3}],x=>x.a,x=>x.b)
    expect(compactTimelineSpans(gapped.spans,.1,()=>false,()=>true)).toHaveLength(2)
  })
  it('keeps long overlapping intervals and stable lanes in a narrow viewport', () => {
    const items = [{a:0,b:1000},{a:10,b:20},{a:30,b:40},{a:50,b:60}]
    const index = createTimelineIndex(items, x=>x.a, x=>x.b)
    expect(index.lanes).toBe(2)
    expect(index.query(35,36).map(x=>x.item)).toEqual([items[0],items[2]])
    expect(index.query(1001,2000)).toEqual([])
    expect(index.spans.map(x=>x.lane)).toEqual([0,1,1,1])
  })
  it('matches an exhaustive overlap search across 100,000 segments', () => {
    const items = Array.from({length:100_000},(_,i)=>({a:i*1000,b:i*1000+500+(i%17)*100}))
    const index = createTimelineIndex(items, x=>x.a, x=>x.b)
    for (const from of [0,12345,50_000_123,99_999_000]) {
      const to=from+5000
      expect(index.query(from,to).map(x=>x.item)).toEqual(items.filter(x=>x.a<=to&&x.b>=from))
    }
  })
})
