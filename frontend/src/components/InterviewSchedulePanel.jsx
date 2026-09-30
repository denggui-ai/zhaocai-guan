import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InterviewScheduleCanonical from './InterviewScheduleCanonical.jsx';

const FIXTURE_INTERVIEWERS = Object.freeze([
  { id: 9101, name: '王面试官（Fixture）', active: 1 },
  { id: 9102, name: '陈面试官（Fixture）', active: 1 },
]);

function fixtureTime(offsetDays, hour = 10) {
  const value = new Date();
  value.setDate(value.getDate() + offsetDays);
  value.setHours(hour, 0, 0, 0);
  return value.toISOString();
}

function interviewerAssignments(interviewers, leadId = 9101) {
  return [{
    interviewer_id: leadId,
    interviewer_name_snapshot: interviewers.find((item) => Number(item.id) === Number(leadId))?.name || 'Fixture 面试官',
    role: 'lead',
  }];
}

function logisticsSnapshot(session) {
  return {
    scheduled_at: session.scheduled_at,
    interview_format: session.interview_format,
    duration_minutes: session.duration_minutes,
    interviewers: session.interviewer_assignments || [],
    meeting_platform: session.meeting_platform,
    meeting_link: session.meeting_link,
    location_address: session.location_address,
    location_room: session.location_room,
    logistics_note: session.logistics_note,
    invitation_status: session.invitation_status,
    invitation_sent_by: session.invitation_sent_by,
    invitation_sent_at: session.invitation_sent_at,
    candidate_confirmation_status: session.candidate_confirmation_status,
    candidate_confirmation_recorded_by: session.candidate_confirmation_recorded_by,
    candidate_confirmation_recorded_at: session.candidate_confirmation_recorded_at,
  };
}

function fixtureSession(candidate, jobId, patch = {}) {
  return {
    id: patch.id,
    candidate_id: candidate.internal_id,
    candidate_name: candidate.name || 'Fixture 候选人',
    job_id: jobId,
    round: patch.round || 1,
    status: patch.status || 'draft',
    interview_format: patch.interview_format || 'online',
    mode: patch.interview_format || 'online',
    duration_minutes: patch.duration_minutes || 45,
    created_at: patch.created_at || fixtureTime(-2),
    interviewer_assignments: patch.interviewer_assignments || [],
    invitation_status: 'pending',
    candidate_confirmation_status: 'pending',
    schedule_confirmations: [],
    logistics_version: 0,
    ...patch,
  };
}

function buildFixtureSessions(candidates, jobId) {
  if (!candidates.length) return [];
  const sessions = [];
  const first = candidates[0];
  const completed = fixtureSession(first, jobId, {
    id: 900001,
    round: 1,
    status: 'confirmed',
    report_status: 'confirmed',
    scheduled_at: fixtureTime(-14),
    duration_minutes: 45,
    interviewer_assignments: interviewerAssignments(FIXTURE_INTERVIEWERS),
    meeting_platform: 'Fixture 会议',
    meeting_link: 'https://fixture.invalid/interview/history',
    logistics_note: '历史面试合成记录，仅用于界面验收。',
    invitation_status: 'sent',
    invitation_sent_by: 'Fixture HR',
    invitation_sent_at: fixtureTime(-15),
    candidate_confirmation_status: 'confirmed',
    candidate_confirmation_recorded_by: 'Fixture HR',
    candidate_confirmation_recorded_at: fixtureTime(-15),
    logistics_version: 1,
  });
  completed.schedule_confirmations = [{
    id: 'fixture-confirmation-900001',
    confirmed_by: 'Fixture HR',
    confirmed_at: fixtureTime(-15),
    logistics_snapshot: logisticsSnapshot(completed),
  }];
  sessions.push(completed);
  sessions.push(fixtureSession(first, jobId, {
    id: 900002,
    round: 2,
    status: 'scheduled',
    scheduled_at: fixtureTime(2),
    interviewer_assignments: interviewerAssignments(FIXTURE_INTERVIEWERS),
    meeting_platform: 'Fixture 会议',
    meeting_link: 'https://fixture.invalid/interview/current',
    logistics_note: '当前面试合成记录，不会连接会议或发送邀请。',
    logistics_version: 1,
  }));

  candidates.slice(1, 4).forEach((candidate, index) => {
    sessions.push(fixtureSession(candidate, jobId, {
      id: 900003 + index,
      round: 1,
      status: index === 0 ? 'draft' : 'pending_review',
      scheduled_at: index === 0 ? null : fixtureTime(-(index + 1)),
      interviewer_assignments: index === 0 ? [] : interviewerAssignments(FIXTURE_INTERVIEWERS, 9102),
      meeting_platform: index === 0 ? '' : 'Fixture 会议',
      meeting_link: index === 0 ? '' : `https://fixture.invalid/interview/${index + 1}`,
      logistics_note: '测试数据合成面试。',
      logistics_version: index === 0 ? 0 : 1,
    }));
  });
  return sessions;
}

export default function InterviewSchedulePanel({
  job,
  jobId,
  candidates = [],
  readOnly,
  onOpenCandidate,
  onOpenCandidates,
  onOpenSettings,
  navigationTarget = null,
  onNavigationTargetConsumed,
}) {
  const fixtureKey = `${jobId || ''}:${candidates.map((item) => item.internal_id).join('|')}`;
  const [sessions, setSessions] = useState(() => buildFixtureSessions(candidates, jobId));
  const [interviewers, setInterviewers] = useState(() => FIXTURE_INTERVIEWERS.map((item) => ({ ...item })));
  const sessionsRef = useRef(sessions);
  const interviewersRef = useRef(interviewers);
  const candidatesRef = useRef(candidates);
  const nextSessionIdRef = useRef(901000);
  const nextInterviewerIdRef = useRef(9200);

  const replaceSessions = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(sessionsRef.current) : updater;
    sessionsRef.current = next;
    setSessions(next);
    return next;
  }, []);

  const replaceInterviewers = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(interviewersRef.current) : updater;
    interviewersRef.current = next;
    setInterviewers(next);
    return next;
  }, []);

  useEffect(() => {
    candidatesRef.current = candidates;
    const nextSessions = buildFixtureSessions(candidates, jobId);
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    const nextInterviewers = FIXTURE_INTERVIEWERS.map((item) => ({ ...item }));
    interviewersRef.current = nextInterviewers;
    setInterviewers(nextInterviewers);
  }, [fixtureKey]);

  const fixtureAdapter = useMemo(() => ({
    listSessions: async () => ({ sessions: sessionsRef.current }),
    listInterviewers: async (includeInactive) => ({
      interviewers: includeInactive
        ? interviewersRef.current
        : interviewersRef.current.filter((item) => Number(item.active) === 1),
    }),
    createSession: async (input) => {
      const candidate = candidatesRef.current.find((item) => String(item.internal_id) === String(input.candidateId));
      if (!candidate) throw new Error('Fixture 候选人不存在');
      const created = fixtureSession(candidate, jobId, {
        id: nextSessionIdRef.current++,
        round: input.round,
        status: 'draft',
        interview_format: input.interviewFormat,
      });
      replaceSessions((current) => [...current, created]);
      return { session: created };
    },
    confirmSchedule: async (sessionId, scheduledAt, requestId, logistics) => {
      let updated = null;
      replaceSessions((current) => current.map((session) => {
        if (String(session.id) !== String(sessionId)) return session;
        const previousSchedule = session.scheduled_at ? logisticsSnapshot(session) : null;
        const assignments = (logistics.interviewerAssignments || []).map((assignment) => ({
          interviewer_id: assignment.interviewerId,
          interviewer_name_snapshot: interviewersRef.current.find((item) => Number(item.id) === Number(assignment.interviewerId))?.name || 'Fixture 面试官',
          role: assignment.role,
        }));
        updated = {
          ...session,
          status: 'scheduled',
          scheduled_at: scheduledAt,
          interview_format: logistics.interviewFormat,
          mode: logistics.interviewFormat,
          duration_minutes: logistics.durationMinutes,
          interviewer_assignments: assignments,
          meeting_platform: logistics.meetingPlatform,
          meeting_link: logistics.meetingLink,
          location_address: logistics.locationAddress,
          location_room: logistics.locationRoom,
          logistics_note: logistics.logisticsNote,
          invitation_status: 'pending',
          invitation_sent_by: '',
          invitation_sent_at: '',
          candidate_confirmation_status: 'pending',
          candidate_confirmation_recorded_by: '',
          candidate_confirmation_recorded_at: '',
          logistics_version: Number(session.logistics_version || 0) + 1,
        };
        const snapshot = logisticsSnapshot(updated);
        if (previousSchedule) snapshot.previous_schedule = previousSchedule;
        updated.schedule_confirmations = [
          ...(session.schedule_confirmations || []),
          {
            id: `fixture-confirmation-${requestId}`,
            confirmed_by: 'Fixture HR',
            confirmed_at: new Date().toISOString(),
            logistics_snapshot: snapshot,
          },
        ];
        return updated;
      }));
      if (!updated) throw new Error('测试面试记录不存在');
      return { session: updated };
    },
    cancelSession: async (sessionId, reasonCode) => {
      replaceSessions((current) => current.map((session) => String(session.id) === String(sessionId)
        ? { ...session, status: 'cancelled', cancel_reason: reasonCode }
        : session));
      return { ok: true };
    },
    saveInterviewer: async (input) => {
      if (input.id) {
        replaceInterviewers((current) => current.map((item) => Number(item.id) === Number(input.id)
          ? { ...item, active: input.active ? 1 : 0 }
          : item));
      } else {
        replaceInterviewers((current) => [...current, {
          id: nextInterviewerIdRef.current++,
          name: input.name,
          active: input.active ? 1 : 0,
        }]);
      }
      return { ok: true };
    },
    markInvitationSent: async (sessionId) => {
      replaceSessions((current) => current.map((session) => String(session.id) === String(sessionId)
        ? { ...session, invitation_status: 'sent', invitation_sent_by: 'Fixture HR', invitation_sent_at: new Date().toISOString() }
        : session));
      return { ok: true };
    },
    recordCandidateConfirmation: async (sessionId, status) => {
      replaceSessions((current) => current.map((session) => String(session.id) === String(sessionId)
        ? {
          ...session,
          candidate_confirmation_status: status,
          candidate_confirmation_recorded_by: 'Fixture HR',
          candidate_confirmation_recorded_at: new Date().toISOString(),
        }
        : session));
      return { ok: true };
    },
  }), [jobId, replaceInterviewers, replaceSessions]);

  const workbench = useMemo(() => ({
    data_class: 'fixture',
    candidates,
    interview_sessions: sessions,
  }), [candidates, sessions]);

  return <InterviewScheduleCanonical
    job={job || { id: jobId, name: 'Fixture 岗位', is_fixture: true }}
    workbench={workbench}
    loadState="ready"
    loadError=""
    readOnly={readOnly}
    onOpenCandidate={onOpenCandidate}
    onOpenCandidates={onOpenCandidates}
    onOpenSettings={onOpenSettings}
    onRefresh={async () => true}
    navigationTarget={navigationTarget}
    onNavigationTargetConsumed={onNavigationTargetConsumed}
    dataAdapter={fixtureAdapter}
    fixtureMode
  />;
}
