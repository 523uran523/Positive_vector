import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

interface Client {
  cookie: string;
  csrf: string;
}

async function req(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  body: unknown,
  client?: Client
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (client?.cookie) headers['Cookie'] = client.cookie;
  if (client?.csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = client.csrf;
  }
  const res = await inject(
    app,
    method,
    url,
    body === undefined ? undefined : JSON.stringify(body),
    headers
  );
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  return { res, status: res.status, data };
}

async function uploadMultipart(
  app: ReturnType<typeof createApp>,
  url: string,
  client: Client,
  fields: Record<string, string>,
  file: { name: string; contentType: string; bytes: Buffer }
) {
  const boundary = 'test-boundary-789';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
      )
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    )
  );
  parts.push(file.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  const res = await inject(app, 'POST', url, body, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    Cookie: client.cookie,
    'X-CSRF-Token': client.csrf,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  return { status: res.status, data };
}

describe('Единый таймер смены, выбор задачи, запросы на правку и закрытые заказы', () => {
  it('1. Выбор задачи на старте (0, 1, >=2), последовательные смены, уведомление о непокрытых и отметка за сегодня', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const app = createApp(db);

    try {
      const setup = await req(app, 'POST', '/api/auth/setup', {
        login: 'admin',
        password: 'long-password-123',
        fullName: 'Администратор',
      });
      const admin: Client = {
        cookie: setup.res.headers.get('set-cookie')!.split(';')[0],
        csrf: setup.data.csrfToken,
      };

      const empRes = await req(
        app,
        'POST',
        '/api/users',
        {
          login: 'installer',
          fullName: 'Монтажник Алексей',
          password: 'long-password-123',
          permissions: { 'orders.edit_assigned': true, 'warehouse.take': true },
        },
        admin
      );
      const empId = empRes.data.user.id as string;

      const empLogin = await req(app, 'POST', '/api/auth/login', {
        login: 'installer',
        password: 'long-password-123',
      });
      const emp: Client = {
        cookie: empLogin.res.headers.get('set-cookie')!.split(';')[0],
        csrf: empLogin.data.csrfToken,
      };

      // 0 targets today -> starts workshop shift directly
      const s0 = await req(app, 'POST', '/api/shifts/start', { tzOffsetMinutes: 0 }, emp);
      assert.equal(s0.status, 201);
      assert.equal(s0.data.shift.shift_type, 'workshop');
      const f0 = await req(
        app,
        'POST',
        '/api/shifts/finish',
        { workDone: 'Подготовка профиля', tzOffsetMinutes: 0 },
        emp
      );
      assert.equal(f0.status, 200);
      assert.equal(f0.data.accruedKopecks, 0);

      // 1 target today -> auto-binds to that visit
      const today = new Date().toISOString().slice(0, 10);
      const ord1 = await req(
        app,
        'POST',
        '/api/orders',
        {
          orderNumber: 'ПВ-101',
          title: 'Вывеска Фасад',
          assigneeIds: [empId],
          visits: [{ title: 'Монтаж 1', scheduledAt: `${today}T10:00`, assigneeIds: [empId] }],
        },
        admin
      );
      assert.equal(ord1.status, 201);
      const visit1Id = ord1.data.order.visits[0].id as string;

      const s1 = await req(app, 'POST', '/api/shifts/start', { tzOffsetMinutes: 0 }, emp);
      assert.equal(s1.status, 201);
      assert.equal(s1.data.shift.shift_type, 'visit');
      assert.equal(s1.data.shift.visit_id, visit1Id);
      const f1 = await req(
        app,
        'POST',
        '/api/shifts/finish',
        { workDone: 'Смонтирована рама', tzOffsetMinutes: 0 },
        emp
      );
      assert.equal(f1.status, 200);

      // 2+ targets today -> POST /start without targetType returns 409 CHOICE_REQUIRED
      const ord2 = await req(
        app,
        'POST',
        '/api/orders',
        {
          orderNumber: 'ПВ-102',
          title: 'Короб 2',
          assigneeIds: [empId],
          visits: [{ title: 'Монтаж 2', scheduledAt: `${today}T14:00`, assigneeIds: [empId] }],
        },
        admin
      );
      const visit2Id = ord2.data.order.visits[0].id as string;

      const qt = await req(
        app,
        'POST',
        '/api/quick-tasks',
        {
          title: 'Забрать плёнку',
          dueDate: today,
          assigneeIds: [empId],
          orderId: ord2.data.order.id,
        },
        admin
      );
      assert.equal(qt.status, 201);
      const quickTaskId = qt.data.task.id as string;

      const optsRes = await req(app, 'GET', '/api/shifts/today-options?tzOffsetMinutes=0', undefined, emp);
      assert.equal(optsRes.status, 200);
      assert.equal(optsRes.data.visits.length, 2);
      assert.equal(optsRes.data.quickTasks.length, 1);
      assert.equal(optsRes.data.totalTargets, 3);

      const sChoice = await req(app, 'POST', '/api/shifts/start', { tzOffsetMinutes: 0 }, emp);
      assert.equal(sChoice.status, 409);
      assert.equal(sChoice.data.code, 'CHOICE_REQUIRED');

      // Explicitly start on quickTask -> finish with completeTarget: true
      const sQt = await req(
        app,
        'POST',
        '/api/shifts/start',
        { targetType: 'quick_task', quickTaskId, orderId: ord2.data.order.id, tzOffsetMinutes: 0 },
        emp
      );
      assert.equal(sQt.status, 201);
      assert.equal(sQt.data.shift.shift_type, 'quick_task');

      const fQt = await req(
        app,
        'POST',
        '/api/shifts/finish',
        { workDone: 'Плёнка доставлена', completeTarget: true, tzOffsetMinutes: 0 },
        emp
      );
      assert.equal(fQt.status, 200);
      assert.equal(fQt.data.uncoveredToday.uncoveredCount, 1); // visit2 still uncovered

      // Notification about uncovered tasks was created (and deduplicated on repeated finish)
      const sWorkshop = await req(
        app,
        'POST',
        '/api/shifts/start',
        { targetType: 'workshop', tzOffsetMinutes: 0 },
        emp
      );
      assert.equal(sWorkshop.status, 201);
      await req(
        app,
        'POST',
        '/api/shifts/finish',
        { workDone: 'Уборка цеха', tzOffsetMinutes: 0 },
        emp
      );

      const empNotifs = await req(app, 'GET', '/api/notifications', undefined, emp);
      const uncoveredNotifs = empNotifs.data.notifications.filter(
        (n: { type: string }) => n.type === 'shift_uncovered_tasks'
      );
      assert.equal(uncoveredNotifs.length, 1);

      // Same-day log works for today, forbidden for yesterday
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const pastLog = await req(
        app,
        'POST',
        '/api/shifts/same-day-log',
        {
          workDate: yesterday,
          startTime: '09:00',
          endTime: '12:00',
          targetType: 'workshop',
          tzOffsetMinutes: 0,
        },
        emp
      );
      assert.equal(pastLog.status, 403);

      const todayLog = await req(
        app,
        'POST',
        '/api/shifts/same-day-log',
        {
          workDate: today,
          startTime: '15:00',
          endTime: '17:30',
          targetType: 'visit',
          orderId: ord2.data.order.id,
          visitId: visit2Id,
          workDone: 'Смонтирован короб 2',
          tzOffsetMinutes: 0,
        },
        emp
      );
      assert.equal(todayLog.status, 201);
      assert.equal(todayLog.data.shift.is_manual_entry, 1);

      const wt = await req(
        app,
        'GET',
        `/api/orders/${ord2.data.order.id}/visits/${visit2Id}/work-times`,
        undefined,
        emp
      );
      assert.equal(wt.status, 200);
      assert.equal(wt.data.items.length, 1);
      assert.equal(wt.data.items[0].start_time, '15:00');
      assert.equal(wt.data.items[0].end_time, '17:30');
    } finally {
      db.close();
    }
  });

  it('2. Запросы на редактирование смен: отправка сотрудником, одобрение/отклонение админом и прямая правка админом', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const app = createApp(db);

    try {
      const setup = await req(app, 'POST', '/api/auth/setup', {
        login: 'admin',
        password: 'long-password-123',
        fullName: 'Администратор',
      });
      const admin: Client = {
        cookie: setup.res.headers.get('set-cookie')!.split(';')[0],
        csrf: setup.data.csrfToken,
      };
      const empRes = await req(
        app,
        'POST',
        '/api/users',
        { login: 'worker1', fullName: 'Смирнов Пётр', password: 'long-password-123' },
        admin
      );
      const empId = empRes.data.user.id as string;
      const empLogin = await req(app, 'POST', '/api/auth/login', {
        login: 'worker1',
        password: 'long-password-123',
      });
      const emp: Client = {
        cookie: empLogin.res.headers.get('set-cookie')!.split(';')[0],
        csrf: empLogin.data.csrfToken,
      };

      const today = new Date().toISOString().slice(0, 10);
      const ord = await req(
        app,
        'POST',
        '/api/orders',
        {
          orderNumber: 'ПВ-201',
          title: 'Баннер',
          assigneeIds: [empId],
          visits: [{ title: 'Выезд 1', scheduledAt: `${today}T10:00`, assigneeIds: [empId] }],
        },
        admin
      );
      const orderId = ord.data.order.id as string;
      const visitId = ord.data.order.visits[0].id as string;

      // Worker runs shift + completes report (times derived)
      const st = await req(app, 'POST', '/api/shifts/start', { targetType: 'visit', orderId, visitId, tzOffsetMinutes: 0 }, emp);
      assert.equal(st.status, 201);
      const shiftId = st.data.shift.id as string;

      // Completing visit report auto-closes active shift and derives times
      const rep = await req(
        app,
        'POST',
        `/api/orders/${orderId}/visits/${visitId}/report`,
        { startTime: '01:00', endTime: '23:00', workDone: 'Смонтировали баннер', tzOffsetMinutes: 0 },
        emp
      );
      assert.equal(rep.status, 201);
      // Verify manual startTime '01:00' from non-admin was NOT used
      const reportRow = rep.data.order.visits[0].reports[0];
      assert.notEqual(reportRow.start_time, '01:00');
      assert.notEqual(reportRow.end_time, '23:00');

      const activeAfterReport = await req(app, 'GET', '/api/shifts/active', undefined, emp);
      assert.equal(activeAfterReport.data.activeShift, null);

      // Worker requests past/corrected shift time
      const reqEdit = await req(
        app,
        'POST',
        '/api/shifts/edit-requests',
        {
          shiftId,
          workDate: today,
          requestedStartTime: '08:30',
          requestedEndTime: '16:45',
          reason: 'Забыл остановить таймер вовремя',
          tzOffsetMinutes: 0,
        },
        emp
      );
      assert.equal(reqEdit.status, 201);
      const reqId = reqEdit.data.request.id as string;

      const adminNotifs = await req(app, 'GET', '/api/notifications', undefined, admin);
      assert.ok(adminNotifs.data.notifications.some((n: { type: string }) => n.type === 'shift_edit_requested'));

      // Admin approves request -> updates shift, visit_work_times, and visit_reports
      const approve = await req(
        app,
        'POST',
        `/api/shifts/edit-requests/${reqId}/review`,
        { decision: 'approve', adminComment: 'Принято', tzOffsetMinutes: 0 },
        admin
      );
      assert.equal(approve.status, 200);
      assert.equal(approve.data.request.status, 'approved');

      const wtAfter = await req(app, 'GET', `/api/orders/${orderId}/visits/${visitId}/work-times`, undefined, emp);
      assert.equal(wtAfter.data.items[0].start_time, '08:30');
      assert.equal(wtAfter.data.items[0].end_time, '16:45');

      const ordAfter = await req(app, 'GET', `/api/orders/${orderId}`, undefined, emp);
      assert.equal(ordAfter.data.order.visits[0].reports[0].start_time, '08:30');
      assert.equal(ordAfter.data.order.visits[0].reports[0].end_time, '16:45');

      // Admin direct edit via PATCH /api/shifts/:id
      const patchRes = await req(
        app,
        'PATCH',
        `/api/shifts/${shiftId}`,
        { workDate: today, startTime: '09:00', endTime: '18:00', workDone: 'Скорректировано админом', tzOffsetMinutes: 0 },
        admin
      );
      assert.equal(patchRes.status, 200);
      const ordAfterPatch = await req(app, 'GET', `/api/orders/${orderId}`, undefined, admin);
      assert.equal(ordAfterPatch.data.order.visits[0].reports[0].start_time, '09:00');
      assert.equal(ordAfterPatch.data.order.visits[0].reports[0].end_time, '18:00');

      // Reject workflow check
      const req2 = await req(
        app,
        'POST',
        '/api/shifts/edit-requests',
        {
          workDate: '2026-01-10',
          requestedStartTime: '10:00',
          requestedEndTime: '14:00',
          reason: 'Ошибочный запрос',
          tzOffsetMinutes: 0,
        },
        emp
      );
      assert.equal(req2.status, 201);
      const rejectRes = await req(
        app,
        'POST',
        `/api/shifts/edit-requests/${req2.data.request.id}/review`,
        { decision: 'reject', adminComment: 'Отклонено' },
        admin
      );
      assert.equal(rejectRes.status, 200);
      assert.equal(rejectRes.data.request.status, 'rejected');
    } finally {
      db.close();
    }
  });

  it('3. Закрытый заказ блокирует правки, отчёты, склад и документы для монтажника, но разрешает загрузку фото', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-closed-order-'));
    const prevUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = uploadRoot;
    const app = createApp(db);

    try {
      const setup = await req(app, 'POST', '/api/auth/setup', {
        login: 'admin',
        password: 'long-password-123',
        fullName: 'Админ',
      });
      const admin: Client = {
        cookie: setup.res.headers.get('set-cookie')!.split(';')[0],
        csrf: setup.data.csrfToken,
      };
      const empRes = await req(
        app,
        'POST',
        '/api/users',
        {
          login: 'emp',
          fullName: 'Монтажник',
          password: 'long-password-123',
          permissions: { 'orders.edit_assigned': true, 'warehouse.take': true },
        },
        admin
      );
      const empId = empRes.data.user.id as string;
      const empLogin = await req(app, 'POST', '/api/auth/login', {
        login: 'emp',
        password: 'long-password-123',
      });
      const emp: Client = {
        cookie: empLogin.res.headers.get('set-cookie')!.split(';')[0],
        csrf: empLogin.data.csrfToken,
      };

      const matRes = await req(
        app,
        'POST',
        '/api/warehouse/materials',
        { name: 'Скотч', unit: 'шт', initialQtyMilli: 10000 },
        admin
      );
      const matId = matRes.data.material.id as string;

      const ord = await req(
        app,
        'POST',
        '/api/orders',
        {
          orderNumber: 'ПВ-301',
          title: 'Закрытый заказ тест',
          assigneeIds: [empId],
          visits: [{ title: 'Выезд', scheduledAt: '2026-08-01T10:00', assigneeIds: [empId] }],
        },
        admin
      );
      const orderId = ord.data.order.id as string;
      const visitId = ord.data.order.visits[0].id as string;

      // Employee submits report -> order auto-completes (becomes closed)
      const rep = await req(
        app,
        'POST',
        `/api/orders/${orderId}/visits/${visitId}/report`,
        { workDone: 'Готово' },
        emp
      );
      assert.equal(rep.status, 201);
      assert.equal(rep.data.order.status, 'completed');
      const reportId = rep.data.order.visits[0].reports[0].id as string;

      // All non-admin mutations on closed order return 403
      assert.equal((await req(app, 'PATCH', `/api/orders/${orderId}`, { title: 'Взлом' }, emp)).status, 403);
      assert.equal((await req(app, 'POST', `/api/orders/${orderId}/visits`, { scheduledAt: '2026-08-02T10:00' }, emp)).status, 403);
      assert.equal((await req(app, 'POST', `/api/orders/${orderId}/visits/${visitId}/report`, { workDone: 'Доп' }, emp)).status, 403);
      assert.equal((await req(app, 'PATCH', `/api/orders/${orderId}/visits/${visitId}/reports/${reportId}`, { workDone: 'Правка' }, emp)).status, 403);
      assert.equal((await req(app, 'DELETE', `/api/orders/${orderId}/visits/${visitId}/reports/${reportId}`, undefined, emp)).status, 403);
      assert.equal(
        (
          await req(
            app,
            'POST',
            `/api/orders/${orderId}/resources`,
            { itemType: 'material', opType: 'issue', materialId: matId, qtyMilli: 1000 },
            emp
          )
        ).status,
        403
      );

      // Uploading a document OR video on a closed order is forbidden (403)
      const docUp = await uploadMultipart(
        app,
        `/api/orders/${orderId}/attachments`,
        emp,
        { kind: 'document' },
        { name: 'act.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 test') }
      );
      assert.equal(docUp.status, 403);

      const vidUp = await uploadMultipart(
        app,
        `/api/orders/${orderId}/attachments`,
        emp,
        { kind: 'photo' },
        { name: 'video.mp4', contentType: 'video/mp4', bytes: Buffer.from('fake-mp4') }
      );
      assert.equal(vidUp.status, 403);

      // Uploading an IMAGE (photo) on a closed order succeeds (201), but deleting it is 403 for non-admin
      const imgUp = await uploadMultipart(
        app,
        `/api/orders/${orderId}/attachments`,
        emp,
        { kind: 'photo', visitId },
        { name: 'result.jpg', contentType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
      );
      assert.equal(imgUp.status, 201);
      const attId = imgUp.data.attachment.id as string;

      assert.equal((await req(app, 'DELETE', `/api/orders/attachments/${attId}`, undefined, emp)).status, 403);

      // Admin CAN still edit and delete on closed order
      assert.equal((await req(app, 'PATCH', `/api/orders/${orderId}`, { title: 'Обновлено админом' }, admin)).status, 200);
      assert.equal((await req(app, 'DELETE', `/api/orders/attachments/${attId}`, undefined, admin)).status, 200);
    } finally {
      db.close();
      if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
      else process.env.UPLOAD_DIR = prevUploadDir;
      fs.rmSync(uploadRoot, { recursive: true, force: true });
    }
  });
});
