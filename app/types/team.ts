export type AttendanceStatus = 'attend' | 'late' | 'absent'
export interface Player { id: string; name: string; active: boolean; joinedAt: string; retiredAt: string | null }
export interface TeamEvent { id: string; date: string; title: string; startTime: string; endTime: string; location: string; note: string; createdByName: string; active: boolean }
export interface Attendance { eventId: string; playerId: string; status: AttendanceStatus; updatedAt: string }
export interface TeamData { version: 1; players: Player[]; events: TeamEvent[]; attendance: Attendance[]; myPlayerIds: string[] }
