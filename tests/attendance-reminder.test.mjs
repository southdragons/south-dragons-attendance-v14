import test from 'node:test'
import assert from 'node:assert/strict'
import {buildReminderText} from '../supabase/functions/attendance-reminder/message.mjs'
const players=[{id:'p1',name:'山田 太郎',active:true},{id:'p2',name:'佐藤 次郎',active:true},{id:'p3',name:'退団した選手',active:false}]
const events=[{id:'e1',title:'午前練習'},{id:'e2',title:'午後試合'}]
test('欠席が0人なら送信本文を作らない',()=>{
  assert.equal(buildReminderText('2026-12-05',events,[{event_id:'e1',player_id:'p1',status:'attend'}],players),null)
})
test('複数予定を1通にまとめ、現役選手の欠席だけ表示',()=>{
  const text=buildReminderText('2026-12-05',events,[
    {event_id:'e1',player_id:'p1',status:'absent'},
    {event_id:'e1',player_id:'p2',status:'late'},
    {event_id:'e1',player_id:'p3',status:'absent'},
    {event_id:'e2',player_id:'p2',status:'absent'},
  ],players)
  assert.match(text,/2026-12-05（土）/)
  assert.match(text,/【午前練習】[\s\S]*欠席：1人[\s\S]*山田 太郎/)
  assert.match(text,/【午後試合】[\s\S]*欠席：1人[\s\S]*佐藤 次郎/)
  assert.doesNotMatch(text,/退団した選手/)
})
test('同じ選手が複数予定を欠席したら各予定に表示',()=>{
  const text=buildReminderText('2026-12-06',events,[
    {event_id:'e1',player_id:'p1',status:'absent'},
    {event_id:'e2',player_id:'p1',status:'absent'},
  ],players)
  assert.equal((text.match(/山田 太郎/g)||[]).length,2)
})
