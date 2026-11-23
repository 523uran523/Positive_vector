import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

type Session = { cookie: string; csrf: string };

test('full business, financial, payroll, and warehouse audit simulation', async () => {
  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-full-audit-'));
  const prevUploadDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploadRoot;

  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);

  async function api(session: Session | null, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session?.cookie) headers.Cookie = session.cookie;
    if (session?.csrf) headers['X-CSRF-Token'] = session.csrf;
    const res = await inject(
      app,
      method,
      url,
      body === undefined ? undefined : JSON.stringify(body),
      headers
    );
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
    return { res, status: res.status, data: data as any };
  }

  async function loginAs(login: string, password: string): Promise<Session> {
    const res = await api(null, 'POST', '/api/auth/login', { login, password });
    assert.equal(res.status, 200, `Login failed for ${login}: ${JSON.stringify(res.data)}`);
    const cookie = res.res.headers.get('set-cookie')!.split(';')[0];
    return { cookie, csrf: res.data.csrfToken };
  }

  try {
    // 1. Setup admin & create 3 employees with varied roles/permissions/rates
    const setupRes = await api(null, 'POST', '/api/auth/setup', {
      login: 'boss',
      password: 'admin-password-123',
      fullName: 'Главный Админ',
    });
    assert.equal(setupRes.status, 201);
    const adminSession: Session = {
      cookie: setupRes.res.headers.get('set-cookie')!.split(';')[0],
      csrf: setupRes.data.csrfToken,
    };

    // Boundary check on invalid user rate
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/users', {
          login: 'badrate',
          fullName: 'Bad Rate',
          password: 'password-12345',
          shiftRateKopecks: -100,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/users', {
          login: 'badrate2',
          fullName: 'Bad Rate 2',
          password: 'password-12345',
          shiftRateKopecks: 123.45,
        })
      ).status,
      400
    );

    const ivanRes = await api(adminSession, 'POST', '/api/users', {
      login: 'ivan',
      fullName: 'Иван Монтажник',
      password: 'ivan-password-123',
      shiftRateKopecks: 350000,
      permissions: {
        'orders.create': true,
        'orders.edit_assigned': true,
        'warehouse.take': true,
      },
    });
    assert.equal(ivanRes.status, 201);
    const ivanId = ivanRes.data.user.id as string;

    const petrRes = await api(adminSession, 'POST', '/api/users', {
      login: 'petr',
      fullName: 'Пётр Цех',
      password: 'petr-password-123',
      shiftRateKopecks: 400000,
      permissions: {
        'warehouse.take': true,
      },
    });
    assert.equal(petrRes.status, 201);
    const petrId = petrRes.data.user.id as string;

    const mariaRes = await api(adminSession, 'POST', '/api/users', {
      login: 'maria',
      fullName: 'Мария Кладовщик',
      password: 'maria-password-123',
      shiftRateKopecks: 300000,
      permissions: {
        'clients.view_all': true,
        'clients.create': true,
        'warehouse.receive': true,
        'warehouse.edit': true,
      },
    });
    assert.equal(mariaRes.status, 201);
    const mariaId = mariaRes.data.user.id as string;

    const ivanSession = await loginAs('ivan', 'ivan-password-123');
    const petrSession = await loginAs('petr', 'petr-password-123');
    const mariaSession = await loginAs('maria', 'maria-password-123');

    // Clear must_change_password flag? Check if endpoints work cleanly with existing auth middleware
    // 2. Companies & contacts + FK validation
    const compARes = await api(adminSession, 'POST', '/api/clients/companies', {
      name: 'ООО Альфа',
      phone: '+79001112233',
    });
    const compBRes = await api(mariaSession, 'POST', '/api/clients/companies', {
      name: 'ООО Бета',
      phone: '+79004445566',
    });
    assert.equal(compARes.status, 201);
    assert.equal(compBRes.status, 201);
    const compAId = compARes.data.company.id as string;
    const compBId = compBRes.data.company.id as string;

    assert.equal(
      (
        await api(adminSession, 'POST', '/api/clients/contacts', {
          companyId: 'nonexistent-company',
          fullName: 'Призрак',
        })
      ).status,
      404
    );

    const contARes = await api(adminSession, 'POST', '/api/clients/contacts', {
      companyId: compAId,
      fullName: 'Сергей Заказчик',
      phone: '+79009998877',
    });
    assert.equal(contARes.status, 201);
    const contAId = contARes.data.contact.id as string;

    // 3. Warehouse: Materials FIFO batches & validation
    assert.equal(
      (
        await api(mariaSession, 'POST', '/api/warehouse/materials', {
          name: 'BadMat',
          initialQtyMilli: -500,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(mariaSession, 'POST', '/api/warehouse/materials', {
          name: 'BadPrice',
          purchasePriceKopecks: 12.5,
        })
      ).status,
      400
    );

    // Batch 1: 10 m @ 100 RUB (10000 kop)
    const bannerRes = await api(mariaSession, 'POST', '/api/warehouse/materials', {
      name: 'Баннер литой 510г',
      category: 'Плёнки и баннеры',
      unit: 'м',
      initialQtyMilli: 10000,
      purchasePriceKopecks: 10000,
      minThresholdMilli: 5000,
    });
    assert.equal(bannerRes.status, 201);
    const bannerId = bannerRes.data.material.id as string;

    // Batch 2: +10 m @ 250 RUB (25000 kop)
    assert.equal(
      (
        await api(mariaSession, 'POST', `/api/warehouse/materials/${bannerId}/operations`, {
          opType: 'receipt',
          qtyMilli: 10000,
          unitCostKopecks: 25000,
          note: 'Вторая поставка',
        })
      ).status,
      201
    );

    // Batch 3: +5 m @ 180 RUB (18000 kop) -> Total 25 m, Total purchase = 10*100 + 10*250 + 5*180 = 4400 RUB (440000 kop)
    assert.equal(
      (
        await api(mariaSession, 'POST', `/api/warehouse/materials/${bannerId}/operations`, {
          opType: 'receipt',
          qtyMilli: 5000,
          unitCostKopecks: 18000,
        })
      ).status,
      201
    );

    let batchesCheck = await api(adminSession, 'GET', `/api/warehouse/materials/${bannerId}/batches`);
    assert.equal(batchesCheck.status, 200);
    assert.equal(batchesCheck.data.stockQtyMilli, 25000);
    assert.equal(batchesCheck.data.averageCostKopecks, 17600);
    assert.equal(batchesCheck.data.purchaseTotalKopecks, 440000);
    assert.equal(batchesCheck.data.stockValueKopecks, 440000);
    assert.equal(batchesCheck.data.costMethod, 'weighted_average');

    // Tool validation: duplicate serials in create / patch, invalid qty
    assert.equal(
      (
        await api(mariaSession, 'POST', '/api/warehouse/tools', {
          name: 'Перфоратор',
          trackingMode: 'individual',
          totalQty: 2,
          serialNumbers: ['PF-01', 'PF-01'],
        })
      ).status,
      400
    );

    const drillRes = await api(mariaSession, 'POST', '/api/warehouse/tools', {
      name: 'Шуруповёрт Makita',
      trackingMode: 'individual',
      totalQty: 2,
      serialNumbers: ['MK-01', 'MK-02'],
    });
    assert.equal(drillRes.status, 201);
    const drillId = drillRes.data.tool.id as string;

    assert.equal(
      (
        await api(mariaSession, 'PATCH', `/api/warehouse/tools/${drillId}`, {
          addSerials: ['MK-02'],
        })
      ).status,
      400
    );

    const ladderRes = await api(mariaSession, 'POST', '/api/warehouse/tools', {
      name: 'Стремянка 6 ст.',
      trackingMode: 'quantity',
      totalQty: 2,
    });
    assert.equal(ladderRes.status, 201);
    const ladderId = ladderRes.data.tool.id as string;

    // Invalid tool op qty rejected cleanly
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'issue',
          qty: 0,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'issue',
          qty: 1.5,
        })
      ).status,
      400
    );

    // 4. Create 5 orders with visits & planned resources
    const todayIso = new Date().toISOString().slice(0, 10);
    const thisMonth = todayIso.slice(0, 7);

    // Order validation: bogus companyId returns 404 (not false 409!)
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/orders', {
          title: 'Bogus Co',
          companyId: 'does-not-exist',
        })
      ).status,
      404
    );

    // Order 1: Completed order with two visits, Alpha, 100 000 RUB (10_000_000 kop)
    const ord1Res = await api(adminSession, 'POST', '/api/orders', {
      orderNumber: 'АУД-001',
      title: 'Вывеска Альфа-1',
      companyId: compAId,
      clientContactId: contAId,
      priceKopecks: 10_000_000,
      scheduledAt: `${todayIso}T09:00`,
      assigneeIds: [ivanId],
      visits: [
        { title: 'Замер и основа', scheduledAt: `${todayIso}T09:00`, assigneeIds: [ivanId] },
        { title: 'Монтаж вывески', scheduledAt: `${todayIso}T14:00`, assigneeIds: [ivanId, petrId] },
      ],
      plannedMaterials: [{ materialId: bannerId, qtyMilli: 12000 }], // reserves 12 m
      plannedTools: [{ toolId: ladderId, qty: 2 }], // reserves 2 ladders
    });
    assert.equal(ord1Res.status, 201);
    const ord1Id = ord1Res.data.order.id as string;
    const visit1Id = ord1Res.data.order.visits[0].id as string;
    const visit2Id = ord1Res.data.order.visits[1].id as string;

    // Order 2: In-progress order scheduled today for Ivan as well, Alpha, 50 000 RUB (5_000_000 kop)
    // Reserve 16m of banner -> together with Order 1 (12m), total reserved = 28m while stock = 25m!
    const ord2Res = await api(adminSession, 'POST', '/api/orders', {
      orderNumber: 'АУД-002',
      title: 'Стенд Альфа-2',
      companyId: compAId,
      priceKopecks: 5_000_000,
      scheduledAt: `${todayIso}T16:00`,
      assigneeIds: [ivanId],
      visits: [{ title: 'Монтаж стенда', scheduledAt: `${todayIso}T16:00`, assigneeIds: [ivanId] }],
      plannedMaterials: [{ materialId: bannerId, qtyMilli: 16000 }],
    });
    assert.equal(ord2Res.status, 201);
    const ord2Id = ord2Res.data.order.id as string;
    const ord2VisitId = ord2Res.data.order.visits[0].id as string;

    // Order 3: Cancelled order with issued/consumed materials + payment + shift accrual, Beta, 30 000 RUB
    const ord3Res = await api(adminSession, 'POST', '/api/orders', {
      orderNumber: 'АУД-003',
      title: 'Отменённый монтаж Бета',
      companyId: compBId,
      priceKopecks: 3_000_000,
      scheduledAt: `${todayIso}T12:00`,
      assigneeIds: [ivanId],
    });
    assert.equal(ord3Res.status, 201);
    const ord3Id = ord3Res.data.order.id as string;

    // Order 4: Completed via full payment, Beta, 20 000 RUB (overpaid later -> debt 0)
    const ord4Res = await api(adminSession, 'POST', '/api/orders', {
      orderNumber: 'АУД-004',
      title: 'Баннер Бета-2',
      companyId: compBId,
      priceKopecks: 2_000_000,
      scheduledAt: `${todayIso}T11:00`,
      assigneeIds: [petrId],
    });
    assert.equal(ord4Res.status, 201);
    const ord4Id = ord4Res.data.order.id as string;

    // Order 5: Previous month order (to verify totalClientDebtKopecks includes all-time debt when period filter active)
    const ord5Res = await api(adminSession, 'POST', '/api/orders', {
      orderNumber: 'АУД-005',
      title: 'Прошломесячный долг Альфа',
      companyId: compAId,
      priceKopecks: 4_000_000, // 40 000 RUB
      scheduledAt: '2026-01-15T10:00',
    });
    assert.equal(ord5Res.status, 201);

    // 5. FIFO Warehouse ops + cross-order reservations
    // Order 1 issues 15 m of banner: 16m is reserved by Order 2 -> 25m - 15m = 10m < 16m -> blocked without confirmReserved!
    const issueBlocked = await api(ivanSession, 'POST', `/api/orders/${ord1Id}/resources`, {
      itemType: 'material',
      opType: 'issue',
      materialId: bannerId,
      qtyMilli: 15000,
    });
    assert.equal(issueBlocked.status, 400);
    assert.match(issueBlocked.data.error, /зарезервирована/);

    // Confirmed issue 15 m on Order 1: takes 10m from Batch 1 (@100) + 5m from Batch 2 (@250)
    const issueOk = await api(ivanSession, 'POST', `/api/orders/${ord1Id}/resources`, {
      itemType: 'material',
      opType: 'issue',
      materialId: bannerId,
      qtyMilli: 15000,
      confirmReserved: true,
    });
    assert.equal(issueOk.status, 201);

    // Consume 10 m on Order 1 from issued pool: consumes Batch 1 (10m @ 100 RUB = 1000 RUB = 100000 kop), 5m from Batch 2 remains issued on Order 1
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/orders/${ord1Id}/resources`, {
          itemType: 'material',
          opType: 'consume',
          materialId: bannerId,
          qtyMilli: 10000,
        })
      ).status,
      201
    );

    // Return remaining 5 m from Order 1 back to stock -> settles issued Batch 2 (@250) cleanly!
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/orders/${ord1Id}/resources`, {
          itemType: 'material',
          opType: 'return',
          materialId: bannerId,
          qtyMilli: 5000,
        })
      ).status,
      201
    );

    // Returning even 1 more milli on Order 1 must fail
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/orders/${ord1Id}/resources`, {
          itemType: 'material',
          opType: 'return',
          materialId: bannerId,
          qtyMilli: 1000,
        })
      ).status,
      400
    );

    // Consume 2 m directly on Order 3 (cancelled later) from remaining stock at weighted avg 176 RUB (17600 kop)
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/materials/${bannerId}/operations`, {
          opType: 'consume',
          qtyMilli: 2000,
          orderId: ord3Id,
          confirmReserved: true,
        })
      ).status,
      201
    );

    // Verify weighted-average remaining stock value:
    // Remaining stock = 13m = 13000 milli, Avg cost = 176 RUB = 17600 kop -> Stock Value = 2288 RUB = 228800 kop
    batchesCheck = await api(adminSession, 'GET', `/api/warehouse/materials/${bannerId}/batches`);
    assert.equal(batchesCheck.data.stockQtyMilli, 13000);
    assert.equal(batchesCheck.data.averageCostKopecks, 17600);
    assert.equal(batchesCheck.data.stockValueKopecks, 228800);
    assert.equal(batchesCheck.data.purchaseTotalKopecks, 440000);

    // Tool checks: issue both ladders (qty=2) to Order 1
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'issue',
          qty: 2,
          orderId: ord1Id,
        })
      ).status,
      201
    );
    // Now 0 ladders available, EVEN though Order 1 only held 2 (and if Order 2 had a reservation, error must be 'Недостаточно инструмента', not 'зарезервирована'!)
    const toolEmptyErr = await api(petrSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
      opType: 'issue',
      qty: 1,
    });
    assert.equal(toolEmptyErr.status, 400);
    assert.match(toolEmptyErr.data.error, /Недостаточно инструмента/);

    // Petr is not assigned to Order 2 -> warehouse tool op on Order 2 must return 403
    assert.equal(
      (
        await api(petrSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'return',
          qty: 1,
          orderId: ord2Id,
        })
      ).status,
      403
    );
    // Petr IS assigned to visit2 of Order 1, so order access passes, but Petr holds 0 ladders -> 400
    assert.equal(
      (
        await api(petrSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'return',
          qty: 1,
          orderId: ord1Id,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(petrSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'return',
          qty: 1,
        })
      ).status,
      400
    );
    // Ivan returns both ladders cleanly
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'return',
          qty: 2,
          orderId: ord1Id,
        })
      ).status,
      201
    );

    // Serialized drill issue & unauthorized employee return guard
    const drillIssueRes = await api(ivanSession, 'POST', `/api/orders/${ord1Id}/resources`, {
      itemType: 'tool',
      opType: 'issue',
      toolId: drillId,
    });
    assert.equal(drillIssueRes.status, 201);
    const drillInstanceId = drillIssueRes.data.order.warehouseOps.find(
      (op: any) => op.id === drillIssueRes.data.operationId
    ).tool_instance_id as string;
    assert.equal(
      (
        await api(petrSession, 'POST', `/api/warehouse/tools/${drillId}/operations`, {
          opType: 'return',
          toolInstanceId: drillInstanceId,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${drillId}/operations`, {
          opType: 'return',
          toolInstanceId: drillInstanceId,
          orderId: ord1Id,
        })
      ).status,
      201
    );

    // FIFO auto-return of quantity tool without orderId + 1-click return-all from an order
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'issue',
          qty: 1,
          orderId: ord1Id,
        })
      ).status,
      201
    );
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'issue',
          qty: 1,
          orderId: ord2Id,
          confirmReserved: true,
        })
      ).status,
      201
    );
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'return',
          qty: 1,
        })
      ).status,
      201
    );
    const ord2ReturnAll = await api(ivanSession, 'POST', `/api/orders/${ord2Id}/tools/return-all`, {});
    assert.equal(ord2ReturnAll.status, 200);
    assert.equal(ord2ReturnAll.data.returnedCount, 1);

    // 6. Unified Shift Timer, Multi-task Picker, Same-day backfill & Edit requests
    // Ivan has multiple targets today (ord1 visit1, ord1 visit2, ord2 visit) -> /start without target must return 409 CHOICE_REQUIRED
    const startAmbiguous = await api(ivanSession, 'POST', '/api/shifts/start', { tzOffsetMinutes: 0 });
    assert.equal(startAmbiguous.status, 409);
    assert.equal(startAmbiguous.data.code, 'CHOICE_REQUIRED');
    assert.ok(startAmbiguous.data.options.totalTargets >= 2);

    // Start shift for visit1
    const shiftStart1 = await api(ivanSession, 'POST', '/api/shifts/start', {
      targetType: 'visit',
      orderId: ord1Id,
      visitId: visit1Id,
      tzOffsetMinutes: 0,
    });
    assert.equal(shiftStart1.status, 201);

    // Starting a second concurrent shift fails with 409
    assert.equal(
      (await api(ivanSession, 'POST', '/api/shifts/start', { targetType: 'workshop' })).status,
      409
    );

    // Finish visit1 shift -> uncoveredTasks remains > 0, sends notification
    const shiftFinish1 = await api(ivanSession, 'POST', '/api/shifts/finish', {
      workDone: 'Собрана подконструкция',
      tzOffsetMinutes: 0,
    });
    assert.equal(shiftFinish1.status, 200);
    const shift1Id = shiftFinish1.data.shift.id as string;
    assert.ok(shiftFinish1.data.uncoveredToday.uncoveredCount >= 1);

    // Employee tries same-day log for yesterday -> 403
    assert.equal(
      (
        await api(ivanSession, 'POST', '/api/shifts/same-day-log', {
          workDate: '2026-01-10',
          startTime: '09:00',
          endTime: '18:00',
          targetType: 'workshop',
          tzOffsetMinutes: 0,
        })
      ).status,
      403
    );

    // Employee uses same-day backfill for visit2 today
    const backfillRes = await api(ivanSession, 'POST', '/api/shifts/same-day-log', {
      workDate: todayIso,
      startTime: '14:00',
      endTime: '17:30',
      targetType: 'visit',
      orderId: ord1Id,
      visitId: visit2Id,
      workDone: 'Монтаж вывески',
      tzOffsetMinutes: 0,
    });
    assert.equal(backfillRes.status, 201);
    const shift2Id = backfillRes.data.shift.id as string;

    // Ivan submits shift edit request for yesterday workshop
    const reqCreate = await api(ivanSession, 'POST', '/api/shifts/edit-requests', {
      targetType: 'workshop',
      workDate: `${thisMonth}-02`,
      requestedStartTime: '10:00',
      requestedEndTime: '18:00',
      workDone: 'Заготовка кронштейнов',
      reason: 'Забыл включить таймер',
      tzOffsetMinutes: 0,
    });
    assert.equal(reqCreate.status, 201);
    const editReqId = reqCreate.data.request.id as string;

    const reqReview = await api(adminSession, 'POST', `/api/shifts/edit-requests/${editReqId}/review`, {
      decision: 'approve',
      adminComment: 'Согласовано',
      tzOffsetMinutes: 0,
    });
    assert.equal(reqReview.status, 200);
    const shift3Id = reqReview.data.shift.id as string;

    // Complete Order 1 via reports -> status becomes completed
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/orders/${ord1Id}/visits/${visit1Id}/report`, {
          workDone: 'Этап 1 сдан',
          completeVisit: true,
        })
      ).status,
      201
    );
    const ord1AfterRep2 = await api(ivanSession, 'POST', `/api/orders/${ord1Id}/visits/${visit2Id}/report`, {
      workDone: 'Этап 2 сдан, всё светится',
      completeVisit: true,
    });
    assert.equal(ord1AfterRep2.status, 201);
    assert.equal(ord1AfterRep2.data.order.status, 'completed');

    // Closed Order 1: Non-admin CANNOT run warehouse material or tool ops on closed order via /warehouse routes!
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/materials/${bannerId}/operations`, {
          opType: 'consume',
          qtyMilli: 1000,
          orderId: ord1Id,
        })
      ).status,
      403
    );
    assert.equal(
      (
        await api(ivanSession, 'POST', `/api/warehouse/tools/${ladderId}/operations`, {
          opType: 'issue',
          qty: 1,
          orderId: ord1Id,
        })
      ).status,
      403
    );

    // Closed Order 1: Non-admin CAN upload photo attachment, CANNOT upload non-image document
    const boundary = 'audit-img-boundary';
    const photoBody = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nphoto\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="done.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`
    );
    const photoUpload = await inject(app, 'POST', `/api/orders/${ord1Id}/attachments`, photoBody, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Cookie: ivanSession.cookie,
      'X-CSRF-Token': ivanSession.csrf,
    });
    assert.equal(photoUpload.status, 201);

    const docBody = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\ndocument\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="act.txt"\r\nContent-Type: text/plain\r\n\r\nDOC\r\n--${boundary}--\r\n`
    );
    const docUpload = await inject(app, 'POST', `/api/orders/${ord1Id}/attachments`, docBody, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Cookie: ivanSession.cookie,
      'X-CSRF-Token': ivanSession.csrf,
    });
    assert.equal(docUpload.status, 403);

    // Non-admin also CANNOT see price_kopecks on orders
    const ivanOrdView = await api(ivanSession, 'GET', `/api/orders/${ord1Id}`);
    assert.equal(ivanOrdView.status, 200);
    assert.equal(ivanOrdView.data.order.price_kopecks, undefined);

    // 7. Salaries & Order 3 cancellation audit
    // Petr starts and finishes a shift linked to Order 3 (to test cancelled order shift-accrual tracking & delete guard!)
    assert.equal(
      (
        await api(ivanSession, 'POST', '/api/shifts/start', {
          targetType: 'visit',
          orderId: ord3Id,
        })
      ).status,
      201
    );
    const ord3ShiftRes = await api(ivanSession, 'POST', '/api/shifts/finish', {
      workDone: 'Подготовка отменена заказчиком',
    });
    assert.equal(ord3ShiftRes.status, 200);
    const ord3ShiftId = ord3ShiftRes.data.shift.id as string;

    // Assign wage 2500 RUB (250_000 kop) for ord3 shift BEFORE cancelling ord3
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/shift-wage', {
          shiftId: ord3ShiftId,
          amountKopecks: 250_000,
        })
      ).status,
      200
    );

    // Deleting Order 3 fails 409 because it has warehouse ops, shifts, and accruals
    assert.equal((await api(adminSession, 'DELETE', `/api/orders/${ord3Id}`)).status, 409);

    // Record advance payment of 10_000 RUB (1_000_000 kop) on Order 3, then cancel Order 3
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/payments', {
          orderId: ord3Id,
          amountKopecks: 1_000_000,
          paymentType: 'advance',
          paidAt: todayIso,
        })
      ).status,
      201
    );
    assert.equal(
      (await api(adminSession, 'PATCH', `/api/orders/${ord3Id}`, { status: 'cancelled' })).status,
      200
    );

    const ord3Detail = await api(adminSession, 'GET', `/api/orders/${ord3Id}`);
    assert.equal(ord3Detail.data.order.cancellationIssues.paymentsKopecks, 1_000_000);
    // CRITICAL AUDIT FIX VERIFICATION: shift accrual on cancelled order MUST show in cancellationIssues.accrualsKopecks!
    assert.equal(ord3Detail.data.order.cancellationIssues.accrualsKopecks, 250_000);
    assert.equal(
      (
        await api(adminSession, 'POST', `/api/orders/${ord3Id}/cancellation-review`, {
          issueKey: 'accruals',
          note: 'Смена оплачена по факту выезда',
        })
      ).status,
      200
    );

    // Assign remaining shift wages, visit wage, bonus/penalty & payouts
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/shift-wage', {
          shiftId: shift1Id,
          amountKopecks: 350_000,
        })
      ).status,
      200
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/shift-wage', {
          shiftId: shift2Id,
          amountKopecks: 350_000,
        })
      ).status,
      200
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/shift-wage', {
          shiftId: shift3Id,
          amountKopecks: 400_000,
        })
      ).status,
      200
    );
    // Validation rejections in salaries
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/adjustments', {
          userId: 'nonexistent',
          amountKopecks: 50_000,
          description: 'Премия',
        })
      ).status,
      404
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/payouts', {
          userId: ivanId,
          amountKopecks: 50_000,
          paidAt: '2026-02-30',
        })
      ).status,
      400
    );

    // Bonus +100_000 kop and penalty -50_000 kop for Ivan
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/adjustments', {
          userId: ivanId,
          amountKopecks: 100_000,
          description: 'Премия за качество',
        })
      ).status,
      201
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/adjustments', {
          userId: ivanId,
          amountKopecks: -50_000,
          description: 'Удержание за опоздание',
        })
      ).status,
      201
    );
    // Total accrued for Ivan = 250_000 + 350_000 + 350_000 + 400_000 + 100_000 - 50_000 = 1_400_000 kop (14 000 RUB)
    // Payout to Ivan: 1_000_000 kop (10 000 RUB) -> remaining = 400_000 kop (4 000 RUB)
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/payouts', {
          userId: ivanId,
          amountKopecks: 1_000_000,
          paidAt: todayIso,
          comment: 'Аванс + ЗП',
        })
      ).status,
      201
    );

    // Bonus 100_000 and Payout 150_000 to Petr -> overpaidKopecks = 50_000!
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/adjustments', {
          userId: petrId,
          amountKopecks: 100_000,
          description: 'Премия цех',
        })
      ).status,
      201
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/salaries/payouts', {
          userId: petrId,
          amountKopecks: 150_000,
          paidAt: todayIso,
        })
      ).status,
      201
    );

    const salSummary = await api(adminSession, 'GET', '/api/salaries/summary');
    assert.equal(salSummary.status, 200);
    const ivanSum = salSummary.data.employees.find((e: any) => e.id === ivanId);
    const petrSum = salSummary.data.employees.find((e: any) => e.id === petrId);
    assert.equal(ivanSum.totalAccruedKopecks, 1_400_000);
    assert.equal(ivanSum.totalPaidKopecks, 1_000_000);
    assert.equal(ivanSum.remainingKopecks, 400_000);
    assert.equal(ivanSum.overpaidKopecks, 0);
    assert.equal(petrSum.totalAccruedKopecks, 100_000);
    assert.equal(petrSum.totalPaidKopecks, 150_000);
    assert.equal(petrSum.remainingKopecks, -50_000);
    assert.equal(petrSum.overpaidKopecks, 50_000);

    const ivanMySal = await api(ivanSession, 'GET', `/api/salaries/my?month=${thisMonth}`);
    assert.equal(ivanMySal.status, 200);
    assert.equal(ivanMySal.data.totalAccruedKopecks, 1_400_000);
    assert.equal(ivanMySal.data.remainingKopecks, 400_000);

    const monthlySal = await api(adminSession, 'GET', '/api/salaries/monthly');
    assert.equal(monthlySal.status, 200);
    const monthRow = monthlySal.data.months.find((m: any) => m.month === thisMonth);
    assert.equal(monthRow.accruedKopecks, 1_500_000); // 1.4M Ivan + 100k Petr
    assert.equal(monthRow.paidKopecks, 1_150_000); // 1.0M Ivan + 150k Petr
    assert.equal(monthRow.deltaKopecks, 350_000);

    // 8. Financial Payments, Expenses & Overview Exact Accounting Reconciliation
    // Reject bad inputs
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/payments', {
          orderId: 'missing-order',
          amountKopecks: 1000,
        })
      ).status,
      404
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/payments', {
          orderId: ord1Id,
          amountKopecks: 1000,
          paidAt: '2026-99-99',
        })
      ).status,
      400
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/expenses', {
          category: 'fuel',
          amountKopecks: 100.5,
        })
      ).status,
      400
    );

    // Order 1 paid 6_000_000 (out of 10_000_000 -> debt 4_000_000)
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/payments', {
          orderId: ord1Id,
          amountKopecks: 6_000_000,
          paymentType: 'partial',
          paidAt: todayIso,
        })
      ).status,
      201
    );
    // Order 4 OVERPAID: 2_500_000 on 2_000_000 order -> order debt = 0 (never negative)
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/payments', {
          orderId: ord4Id,
          amountKopecks: 2_500_000,
          paymentType: 'full',
          paidAt: todayIso,
        })
      ).status,
      201
    );

    // Record operating expense (fuel: 200_000 kop), stock purchase (materials: 440_000 kop), manual salary cash (salaries: 30_000 kop)
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/expenses', {
          category: 'fuel',
          amountKopecks: 200_000,
          expenseDate: todayIso,
          description: 'Бензин',
        })
      ).status,
      201
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/expenses', {
          category: 'materials',
          amountKopecks: 440_000,
          expenseDate: todayIso,
          description: 'Закуп баннера',
        })
      ).status,
      201
    );
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/expenses', {
          category: 'salaries',
          amountKopecks: 30_000,
          expenseDate: todayIso,
          description: 'Суточные вручную',
        })
      ).status,
      201
    );

    // Override check on Order 1: invalid negative rejected
    assert.equal(
      (
        await api(adminSession, 'POST', `/api/finance/orders/${ord1Id}/cost-override`, {
          costOverrideKopecks: -1,
        })
      ).status,
      400
    );

    // Full overview check (unfiltered):
    // Active orders revenue: ord1(10M) + ord2(5M) + ord4(2M) + ord5(4M) = 21_000_000 kop (ord3 cancelled excluded!)
    // Total received cash: ord3(1M) + ord1(6M) + ord4(2.5M) = 9_500_000 kop
    // Debt per active order: ord1(4M) + ord2(5M) + ord4(0) + ord5(4M) = 13_000_000 kop
    // Overpayment per active order: ord4(500_000) = 500_000 kop
    // Effective material COGS (weighted avg 17600 kop/m): ord1(10m = 176_000) + cancelled ord3(2m = 35_200) = 211_200 kop
    // Accrued salaries: 1_500_000 kop
    // Operating expenses (excluding materials & salaries): 200_000 kop
    // Accrual Profit (by actual cash received - COGS - accrued salaries - OpEx) = 9_500_000 - (211_200 + 1_500_000 + 200_000) = 7_588_800 kop
    // Cash Out = paidSalaries(1_150_000) + materialPurchases(440_000) + opEx(200_000) + manualSalary(30_000) = 1_820_000 kop
    // Net Cash Flow = 9_500_000 - 1_820_000 = 7_680_000 kop
    const ovAll = await api(adminSession, 'GET', '/api/finance/overview');
    assert.equal(ovAll.status, 200);
    const m = ovAll.data.metrics;
    assert.equal(m.totalOrderPriceKopecks, 21_000_000);
    assert.equal(m.totalReceivedCashKopecks, 9_500_000);
    assert.equal(m.totalClientDebtKopecks, 13_000_000);
    assert.equal(m.totalClientOverpaidKopecks, 500_000);
    assert.equal(m.periodClientDebtKopecks, 13_000_000);
    assert.equal(m.effectiveMaterialCostKopecks, 211_200);
    assert.equal(m.cancelledOrderMaterialCostKopecks, 35_200);
    assert.equal(m.accruedSalariesKopecks, 1_500_000);
    assert.equal(m.paidSalariesKopecks, 1_150_000);
    assert.equal(m.manualSalaryExpensesKopecks, 30_000);
    assert.equal(m.operatingExpensesKopecks, 200_000);
    assert.equal(m.accrualProfitKopecks, 7_588_800);
    assert.equal(m.cashOutKopecks, 1_820_000);
    assert.equal(m.netCashFlowKopecks, 7_680_000);

    // Order breakdown includes salary_cost_kopecks (700_000 on ord1) & profit_kopecks
    const ord1Econ = ovAll.data.orderBreakdown.find((o: any) => o.id === ord1Id);
    assert.equal(ord1Econ.effective_material_cost_kopecks, 176_000);
    assert.equal(ord1Econ.salary_cost_kopecks, 700_000);
    assert.equal(ord1Econ.profit_kopecks, 10_000_000 - 176_000 - 700_000);
    assert.ok(Array.isArray(ovAll.data.monthlySummary) && ovAll.data.monthlySummary.some((row: any) => row.month === thisMonth));

    // Clients endpoint returns strictly per-order company debt & overpayment
    const clientsAll = await api(adminSession, 'GET', '/api/clients');
    assert.equal(clientsAll.status, 200);
    const compAData = clientsAll.data.companies.find((c: any) => c.id === compAId);
    const compBData = clientsAll.data.companies.find((c: any) => c.id === compBId);
    assert.equal(compAData.debt_kopecks, 13_000_000);
    assert.equal(compBData.debt_kopecks, 0);
    assert.equal(compBData.overpaid_kopecks, 500_000);

    // Filtered period (thisMonth): ord5 (2026-01-15) excluded from periodClientDebtKopecks (9M),
    // BUT totalClientDebtKopecks STILL reports full 13M!
    const ovMonth = await api(
      adminSession,
      'GET',
      `/api/finance/overview?from=${thisMonth}-01&to=${thisMonth}-31`
    );
    assert.equal(ovMonth.status, 200);
    assert.equal(ovMonth.data.metrics.periodClientDebtKopecks, 9_000_000);
    assert.equal(ovMonth.data.metrics.totalClientDebtKopecks, 13_000_000);

    // Override Order 1 material cost to 125_000 kop (delta -51_000) -> accrual profit increases by 51_000
    assert.equal(
      (
        await api(adminSession, 'POST', `/api/finance/orders/${ord1Id}/cost-override`, {
          costOverrideKopecks: 125_000,
          reason: 'Доставка баннера',
        })
      ).status,
      200
    );
    const ovOverride = await api(adminSession, 'GET', '/api/finance/overview');
    assert.equal(ovOverride.data.metrics.effectiveMaterialCostKopecks, 160_200);
    assert.equal(ovOverride.data.metrics.accrualProfitKopecks, 7_639_800);

    // Refund validation & operation: refund exceeding net paid fails 400; refunding 500_000 overpayment reduces cash & overpayment cleanly
    assert.equal(
      (
        await api(adminSession, 'POST', '/api/finance/payments', {
          orderId: ord4Id,
          amountKopecks: 2_600_000,
          paymentType: 'refund',
          paidAt: todayIso,
        })
      ).status,
      400
    );
    const refundRes = await api(adminSession, 'POST', '/api/finance/payments', {
      orderId: ord4Id,
      amountKopecks: 500_000,
      paymentType: 'refund',
      paidAt: todayIso,
      comment: 'Возврат переплаты',
    });
    assert.equal(refundRes.status, 201);
    assert.equal(refundRes.data.amountKopecks, -500_000);
    assert.equal(refundRes.data.paymentType, 'refund');
    const ovAfterRefund = await api(adminSession, 'GET', '/api/finance/overview');
    assert.equal(ovAfterRefund.data.metrics.totalReceivedCashKopecks, 9_000_000);
    assert.equal(ovAfterRefund.data.metrics.totalRefundedCashKopecks, 500_000);
    assert.equal(ovAfterRefund.data.metrics.totalClientOverpaidKopecks, 0);
    assert.equal(ovAfterRefund.data.metrics.totalClientDebtKopecks, 13_000_000);
    assert.equal(ovAfterRefund.data.metrics.netCashFlowKopecks, 7_180_000);

    // 9. XLSX Full Export Sanity Check
    const expRes = await api(adminSession, 'GET', '/api/export/database.xlsx');
    assert.equal(expRes.status, 200);
    const wb = XLSX.read(Buffer.from(expRes.data as ArrayBuffer), { type: 'buffer' });
    for (const sheet of ['Заказы', 'Платежи клиентов', 'Расходы', 'Материалы', 'Инструменты', 'Начисления ЗП', 'Выплаты ЗП']) {
      assert.ok(wb.SheetNames.includes(sheet), `Missing export sheet ${sheet}`);
    }
  } finally {
    db.close();
    if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = prevUploadDir;
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
