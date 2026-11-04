export type AttendanceStatus = 'attend' | 'late' | 'absent'
export interface Player { id: string; name: string; active: boolean; joinedAt: string; retiredAt: string | null }
export interface TeamEvent { id: string; date: string; title: string; startTime: string; endTime: string; location: string; note: string; createdByName: string; active: boolean }
export interface Attendance { eventId: string; playerId: string; status: AttendanceStatus; updatedAt: string }
export interface TeamData { version: 1; players: Player[]; events: TeamEvent[]; attendance: Attendance[]; myPlayerIds: string[] }

export interface DeviceAccess { id: string; playerId: string; applicantName: string; relation: string; grantedAt: string; lastSeenAt: string | null; isCurrentDevice: boolean }
export interface RegistrationRequest { applicantName?: string; relation?: string; id: string; playerId: string; playerName: string; status: 'pending' | 'approved' | 'rejected'; requestedAt: string; reviewedAt: string | null; isMine: boolean; notificationStatus: string }
export interface PendingAttendance { requestId: string; eventId: string; playerId: string; status: AttendanceStatus | null; comment: string; updatedAt: string }
export interface TeamCodeStatus { issued: boolean; version: number; enforcement: 'on' | 'off'; updatedAt: string; previousValidUntil: string | null }
export interface TeamMember { id: string; method: 'code' | 'existing_access' | 'admin'; label: string; verifiedAt: string; lastSeenAt: string | null; isCurrentDevice: boolean; players: string[] }
export interface TeamMemberCounts { code: number; existingAccess: number; admin: number; revoked: number }
/** Devices that are not members yet: admitted automatically on switch-on (a confirmed player) or asked for the code. */
export interface AdmissionPreview { admitted: number; needsCode: number }
