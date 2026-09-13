import { computed, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTeam } from '../app/composables/useTeam'
import { callSupabase } from '../app/utils/supabase'
vi.mock('../app/utils/supabase', () => ({ callSupabase: vi.fn() }))
const api=vi.mocked(callSupabase)
const request={id:'r1',playerId:'p1',playerName:'太郎',status:'pending',requestedAt:'2026-09-13T00:00:00Z',isMine:true}
function snapshot(multi=false, admin=false) {
  return {version:1,players:[],events:[],attendance:[],myPlayerIds:[],admin,adminConfigured:true,
    requests:[request],pendingAttendance:[],...(multi?{accessModel:'multi-device'}:{})}
}
beforeEach(()=>{
  api.mockReset()
  const states=new Map()
  vi.stubGlobal('useState',(key:string,init:()=>unknown)=>{if(!states.has(key)) states.set(key,ref(init()));return states.get(key)})
  vi.stubGlobal('ref',ref);vi.stubGlobal('computed',computed);vi.stubGlobal('onMounted',()=>{})
  vi.stubGlobal('useRuntimeConfig',()=>({public:{dataBackend:'supabase'}}))
})
afterEach(()=>vi.unstubAllGlobals())
it('keeps the published client compatible with the old database before migration',async()=>{
  const team=useTeam();const data=snapshot()
  api.mockResolvedValueOnce(data);await team.refresh()
  expect(team.multiDeviceAccess.value).toBe(false)
  expect(team.canEdit('p1')).toBe(true)
  api.mockResolvedValue({snapshot:data})
  await team.requestRegistration('p1')
  expect(api).toHaveBeenLastCalledWith('requestRegistration',{playerId:'p1'})
  await team.saveAttendance('e1','p1','late')
  expect(api).toHaveBeenLastCalledWith('savePendingAttendance',{eventId:'e1',playerId:'p1',status:'late',requestId:'r1'})
  await team.reviewRegistration('r1','approved')
  expect(api).toHaveBeenLastCalledWith('reviewRegistration',{requestId:'r1',decision:'approved'})
})
it('switches to approved-device access on refresh without exposing draft editing',async()=>{
  const team=useTeam()
  api.mockResolvedValueOnce(snapshot());await team.refresh()
  api.mockResolvedValueOnce(snapshot(true));await team.refresh()
  expect(team.multiDeviceAccess.value).toBe(true)
  expect(team.canEdit('p1')).toBe(false)
  api.mockResolvedValue({snapshot:snapshot(true)})
  await team.requestRegistration('p1','山田 花子','母')
  expect(api).toHaveBeenLastCalledWith('requestRegistration',{playerId:'p1',applicantName:'山田 花子',relation:'母',accessModel:'multi-device'})
  const approved={...snapshot(true),myPlayerIds:['p1'],requests:[]}
  api.mockResolvedValueOnce(approved);await team.refresh()
  expect(team.canEdit('p1')).toBe(true)
  expect(team.canEdit('p2')).toBe(false)
  api.mockResolvedValue({snapshot:approved})
  await team.saveAttendance('e1','p1','attend')
  expect(api).toHaveBeenLastCalledWith('saveAttendance',{eventId:'e1',playerId:'p1',status:'attend',requestId:undefined})
})
it('sends explicit new approval semantics and removes revoked access on refresh',async()=>{
  const team=useTeam()
  api.mockResolvedValueOnce({...snapshot(true,true),myPlayerIds:['p1']});await team.refresh()
  api.mockResolvedValue({snapshot:snapshot(true,true)})
  await team.reviewRegistration('r1','approved')
  expect(api).toHaveBeenLastCalledWith('reviewRegistration',{requestId:'r1',decision:'approved',accessModel:'multi-device'})
  await team.revokeDeviceAccess('a1')
  expect(api).toHaveBeenLastCalledWith('revokeDeviceAccess',{accessId:'a1',accessModel:'multi-device'})
  expect(team.canEdit('p1')).toBe(false)
})
it('drops device details outside an admin snapshot and blocks ordinary revocation',async()=>{
  const team=useTeam(),deviceAccess=[{id:'a1',playerId:'p1',applicantName:'山田 花子',relation:'母'}]
  api.mockResolvedValueOnce({...snapshot(true,true),deviceAccess});await team.refresh()
  expect(team.deviceAccess.value).toHaveLength(1)
  api.mockResolvedValueOnce({...snapshot(true),deviceAccess});await team.refresh()
  expect(team.deviceAccess.value).toEqual([])
  const calls=api.mock.calls.length
  await expect(team.revokeDeviceAccess('a1')).rejects.toThrow('管理画面にログイン')
  expect(api.mock.calls).toHaveLength(calls)
})
