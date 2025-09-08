/* server/index.js */
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { formatISO, startOfDay } from 'date-fns';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;
app.use(cors());
app.use(express.json());

// ── In-Memory 저장소 (DB 전까지)
const quotes = {
  '2025-09-08': {
    id: '2025-09-08',
    template: '(A)를 예측하는 최선의 방법은\n(B)를 창조하는 것이다.',
    author: '앨런 케이',
    answerA: '미래',
    answerB: '미래',
  },
};
const submissions = new Map(); // submissionId -> { id, quoteId, deviceId, fillA, fillB, likes:Set }

// ── 미들웨어: 기기 식별 (익명)
app.use((req, _res, next) => {
  const did = req.header('X-Device-Id');
  req.deviceId = did || null;
  next();
});

// ── 유틸: 하루 키(quoteId+deviceId+YYYY-MM-DD)
const dayKey = (quoteId, deviceId) => {
  const day = formatISO(startOfDay(new Date()), { representation: 'date' });
  return `${quoteId}:${deviceId}:${day}`;
};
const dayLocks = new Set(); // 오늘 제출/건너뛰기 잠금 키 집합

// 헬스체크
app.get('/health', (_req, res) => res.json({ ok: true }));

// 오늘의 명언
app.get('/quotes/today', (req, res) => {
  const q = quotes['2025-09-08']; // TODO: 날짜/로테 로직
  const locked = req.deviceId
    ? dayLocks.has(dayKey(q.id, req.deviceId))
    : false;
  res.json({ quote: q, locked });
});

// 제출 스키마
const SubmitBody = z.object({
  fillA: z.string().min(1).max(24),
  fillB: z.string().min(1).max(24),
});

// 제출하기
app.post('/quotes/:id/submissions', (req, res) => {
  if (!req.deviceId)
    return res.status(400).json({ message: 'X-Device-Id header required' });
  const { id } = req.params;
  if (!quotes[id]) return res.status(404).json({ message: 'Quote not found' });
  if (dayLocks.has(dayKey(id, req.deviceId))) {
    return res
      .status(409)
      .json({ message: 'Already submitted or skipped today' });
  }

  const parsed = SubmitBody.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ message: 'Invalid body', issues: parsed.error.issues });
  }

  const newId = nanoid(12);
  submissions.set(newId, {
    id: newId,
    quoteId: id,
    deviceId: req.deviceId,
    ...parsed.data,
    likes: new Set(),
  });
  dayLocks.add(dayKey(id, req.deviceId));
  res.status(201).json({ id: newId });
});

// 건너뛰기
app.post('/quotes/:id/skip', (req, res) => {
  if (!req.deviceId)
    return res.status(400).json({ message: 'X-Device-Id header required' });
  const { id } = req.params;
  if (!quotes[id]) return res.status(404).json({ message: 'Quote not found' });
  dayLocks.add(dayKey(id, req.deviceId));
  res.status(204).end();
});

// 랭킹(좋아요 내림차순 → 동일 시 최근 제출 우선)
app.get('/quotes/:id/ranking', (req, res) => {
  const { id } = req.params;
  const list = [...submissions.values()].filter((s) => s.quoteId === id);
  list.sort((a, b) => b.likes.size - a.likes.size || (a.id < b.id ? 1 : -1));
  const items = list.map((s) => ({
    id: s.id,
    quoteId: s.quoteId,
    fillA: s.fillA,
    fillB: s.fillB,
    likes: s.likes.size,
  }));
  res.json({ items });
});

// 좋아요 토글
app.post('/submissions/:sid/like', (req, res) => {
  if (!req.deviceId)
    return res.status(400).json({ message: 'X-Device-Id header required' });
  const s = submissions.get(req.params.sid);
  if (!s) return res.status(404).json({ message: 'Submission not found' });
  if (s.likes.has(req.deviceId)) s.likes.delete(req.deviceId);
  else s.likes.add(req.deviceId);
  res.json({ likes: s.likes.size });
});

// 에러 핸들링
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal error' });
});

app.listen(PORT, () => console.log(`Waise API on :${PORT}`));

// Flutter 연동 메모
// - 앱 최초 실행: UUID 생성 후 SharedPreferences 보관 → 모든 요청에 X-Device-Id 헤더 첨부.
// - /quotes/today 의 locked=true면 제출/건너뛰기 비활성화.
// - 서버 dayLocks로 이중 잠금(서버 최종 권한).
