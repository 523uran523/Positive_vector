import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

type CallResult = { status: number; data: unknown };

/** Boot an in-memory app and return a helper that carries the admin cookie + csrf. */
async function bootAdmin() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = createApp(db);
  let cookie = '';
  let csrf = '';
  const call = async (method: string, url: string, body?: unknown): Promise<CallResult> => {
    const res = await inject(
      app,
      method,
      url,
      body === undefined ? undefined : JSON.stringify(body),
      { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }
    );
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : null;
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    if (data && typeof data === 'object' && 'csrfToken' in data) csrf = (data as { csrfToken?: string }).csrfToken || csrf;
    return { status: res.status, data };
  };
  const setup = await call('POST', '/api/auth/setup', {
    login: 'admin',
    password: 'long-password-123',
    fullName: 'Admin',
  });
  assert.equal(setup.status, 201, 'admin setup');
  return { db, app, call, getCookie: () => cookie, getCsrf: () => csrf };
}

test('salary summary, ledger and monthly endpoints return consistent debt breakdowns', async () => {
  const { db, call } = await bootAdmin();
  try {
    // Create an employee.
    const worker = await call('POST', '/api/users', {
      login: 'worker',
      fullName: 'Worker One',
      password: 'long-password-123',
    });
    assert.equal(worker.status, 201, 'create worker');
    const workerId = (worker.data as { user: { id: string } }).user.id;

    // Create an order with one visit and the worker as the sole visit assignee.
    const order = await call('POST', '/api/orders', {
      orderNumber: 'ORD-1',
      title: 'Order one',
      visits: [
        { title: 'Visit one', scheduledAt: '2026-01-01T09:00:00.000Z', assigneeIds: [workerId] },
      ],
    });
    assert.equal(order.status, 201, 'create order with visit');
    const orderId = (order.data as { order: { id: string } }).order.id;
    // Read back the generated visit + assignee ids so the visit-wage call is well-formed.
    const visitRow = db
      .prepare(`SELECT ov.id AS visit_id, va.id AS assignee_id FROM order_visits ov JOIN visit_assignees va ON va.visit_id = ov.id WHERE ov.order_id = ?`)
      .get(orderId) as { visit_id: string; assignee_id: string };
    assert.ok(visitRow, 'visit and assignee exist');
    db.prepare("UPDATE order_visits SET status='completed' WHERE id=?").run(visitRow.visit_id);
    db.prepare("INSERT INTO visit_reports(id,visit_id,order_id,user_id,work_done,created_at) VALUES('report-1',?,?,?,'Done','2026-01-06T10:00:00Z')").run(visitRow.visit_id,orderId,workerId);
    db.prepare("INSERT INTO workshop_shifts(id,user_id,started_at,ended_at,status,rate_snapshot_kopecks,created_at) VALUES('shift-1',?,'2026-02-04T08:00:00Z','2026-02-04T16:00:00Z','completed',300000,'2026-02-04T08:00:00Z')").run(workerId);
    db.prepare("INSERT INTO workshop_shifts(id,user_id,started_at,status,rate_snapshot_kopecks,created_at) VALUES('shift-active',?,'2026-02-05T08:00:00Z','active',300000,'2026-02-05T08:00:00Z')").run(workerId);

    // 1) Visit accrual via the API → source_type='visit', linked to the order.
    const visitWage = await call('POST', '/api/salaries/visit-wage', {
      visitId: visitRow.visit_id,
      userId: workerId,
      amountKopecks: 150000,
    });
    assert.equal(visitWage.status, 200, 'assign visit wage');
    const visitAccrualId = (
      db
        .prepare(`SELECT id FROM salary_accruals WHERE source_type = 'visit' AND source_id = ? AND user_id = ?`)
        .get(visitRow.visit_id, workerId) as { id: string }
    ).id;
    // Backdate it into January for stable monthly bucketing.
    db.prepare(`UPDATE salary_accruals SET created_at = ? WHERE id = ?`).run('2026-01-05T10:00:00.000Z', visitAccrualId);

    // 2) A shift accrual, seeded directly with a January date.
    db.prepare(
      `INSERT INTO salary_accruals(id, user_id, source_type, source_id, amount_kopecks, description, created_at)
       VALUES (?, ?, 'shift', 'active-shift', 300000, 'Shift in workshop', ?)`
    ).run(`acc-shift-${workerId.slice(0, 8)}`, workerId, '2026-01-05T11:00:00.000Z');

    // 3) A positive bonus and a negative penalty, both backdated into February.
    const bonus = await call('POST', '/api/salaries/adjustments', {
      userId: workerId,
      amountKopecks: 50000,
      description: 'Bonus',
    });
    assert.equal(bonus.status, 201, 'manual bonus');
    const penalty = await call('POST', '/api/salaries/adjustments', {
      userId: workerId,
      amountKopecks: -20000,
      description: 'Penalty',
    });
    assert.equal(penalty.status, 201, 'manual penalty');
    db.prepare(`UPDATE salary_accruals SET created_at = ? WHERE id = ?`).run(
      '2026-02-03T09:00:00.000Z',
      (bonus.data as { id: string }).id
    );
    db.prepare(`UPDATE salary_accruals SET created_at = ? WHERE id = ?`).run(
      '2026-02-04T09:00:00.000Z',
      (penalty.data as { id: string }).id
    );

    // 4) A partial payout.
    const payout = await call('POST', '/api/salaries/payouts', {
      userId: workerId,
      amountKopecks: 70000,
      paidAt: '2026-02-10',
      comment: 'Partial payout',
    });
    assert.equal(payout.status, 201, 'create payout');
    const payoutRow = db
      .prepare(`SELECT amount_kopecks, paid_at, comment FROM salary_payouts WHERE id = ?`)
      .get((payout.data as { id: string }).id) as { amount_kopecks: number; paid_at: string; comment: string };
    assert.equal(payoutRow.amount_kopecks, 70000, 'payout amount stored');
    assert.equal(payoutRow.paid_at, '2026-02-10', 'payout date stored');
    assert.equal(payoutRow.comment, 'Partial payout', 'payout comment stored');

    // ---- Expected totals -----------------------------------------------------
    const totalAccrued = 150000 + 300000 + 50000 - 20000; // 480000
    const totalPaid = 70000;
    const remaining = totalAccrued - totalPaid; // 410000

    // ---- /summary ------------------------------------------------------------
    const summary = await call('GET', '/api/salaries/summary');
    assert.equal(summary.status, 200, 'summary');
    const employees = (summary.data as { employees: Array<Record<string, unknown>> }).employees;
    const workerSummary = employees.find((s) => s.id === workerId);
    assert.ok(workerSummary, 'worker present in summary');
    assert.deepEqual(workerSummary.activity, [{month:'2026-02',visits:0,shifts:1},{month:'2026-01',visits:1,shifts:0}]);
    assert.equal(workerSummary.visitAccruedKopecks, 150000);
    assert.equal(workerSummary.shiftAccruedKopecks, 300000);
    assert.equal(workerSummary.manualAccruedKopecks, 30000);
    assert.equal(workerSummary.totalAccruedKopecks, totalAccrued);
    assert.equal(workerSummary.totalPaidKopecks, totalPaid);
    assert.equal(workerSummary.remainingKopecks, remaining);
    assert.equal(workerSummary.overpaidKopecks, 0, 'no overpay when debt is positive');
    // The visit accrual should carry the order context after the join.
    const visitAccrual = (workerSummary.accruals as Array<Record<string, unknown>>).find(
      (a) => a.source_type === 'visit'
    )!;
    assert.equal(visitAccrual.order_number, 'ORD-1');
    assert.equal(visitAccrual.visit_title, 'Visit one');
    assert.equal(workerSummary.lastOperationAt, '2026-02-10', 'payout paid_at is stored as a date (YYYY-MM-DD)');

    // ---- /ledger (full history, newest first) --------------------------------
    const ledger = await call('GET', `/api/salaries/ledger?userId=${workerId}&limit=200`);
    assert.equal(ledger.status, 200, 'ledger');
    const entries = (ledger.data as { entries: Array<Record<string, unknown>> }).entries;
    assert.equal(entries.length, 5, 'ledger has all operations');
    // Newest first: payout (2026-02-10) is the most recent.
    assert.equal(entries[0].kind, 'payout');
    assert.equal(entries[0].occurred_at, '2026-02-10', 'payout occurred_at is the paid_at date');
    // The visit accrual row exposes the order id/number for the UI link.
    const ledgerVisit = entries.find((e) => e.source === 'visit' && e.kind === 'accrual')!;
    assert.equal(ledgerVisit.order_id, orderId);
    assert.equal(ledgerVisit.order_number, 'ORD-1');

    // ---- /ledger date filtering (from/to as YYYY-MM-DD) ----------------------
    // Only February operations: bonus (02-03), penalty (02-04), payout (02-10).
    const febLedger = await call('GET', `/api/salaries/ledger?userId=${workerId}&from=2026-02-01&to=2026-02-29&limit=200`);
    assert.equal(febLedger.status, 200, 'filtered ledger');
    const febEntries = (febLedger.data as { entries: Array<Record<string, unknown>> }).entries;
    assert.equal(febEntries.length, 3, 'three February operations');
    const febKinds = febEntries.map((e) => e.kind).sort();
    assert.deepEqual(febKinds, ['accrual', 'accrual', 'payout']);

    // Boundary: a single-day window captures exactly the payout.
    const oneDay = await call('GET', `/api/salaries/ledger?userId=${workerId}&from=2026-02-10&to=2026-02-10&limit=200`);
    const oneDayEntries = (oneDay.data as { entries: Array<Record<string, unknown>> }).entries;
    assert.equal(oneDayEntries.length, 1);
    assert.equal(oneDayEntries[0].kind, 'payout');

    // Missing userId must be rejected.
    assert.equal((await call('GET', '/api/salaries/ledger')).status, 400, 'ledger requires userId');

    // ---- /monthly ------------------------------------------------------------
    const monthly = await call('GET', '/api/salaries/monthly');
    assert.equal(monthly.status, 200, 'monthly');
    const months = (monthly.data as { months: Array<Record<string, unknown>> }).months;
    assert.equal(months.length, 2, 'two active months');
    assert.equal(months[0].month, '2026-02', 'newest month first');
    assert.equal(months[1].month, '2026-01');

    const jan = months.find((m) => m.month === '2026-01')!;
    const feb = months.find((m) => m.month === '2026-02')!;
    // January: visit (150000) + shift (300000) = 450000 accrued, no payouts.
    assert.equal(jan.accruedKopecks, 450000);
    assert.equal(jan.paidKopecks, 0);
    assert.equal(jan.deltaKopecks, 450000);
    // February: bonus + penalty accrued (50000 - 20000 = 30000), payout 70000.
    assert.equal(feb.accruedKopecks, 30000);
    assert.equal(feb.paidKopecks, 70000);
    assert.equal(feb.deltaKopecks, -40000);

    // Per-employee breakdown inside each month.
    const janEmp = (jan.employees as Array<Record<string, unknown>>).find((e) => e.userId === workerId)!;
    assert.equal(janEmp.visitKopecks, 150000);
    assert.equal(janEmp.shiftKopecks, 300000);
    assert.equal(janEmp.paidKopecks, 0);

    const febEmp = (feb.employees as Array<Record<string, unknown>>).find((e) => e.userId === workerId)!;
    assert.equal(febEmp.visitKopecks, 0);
    assert.equal(febEmp.shiftKopecks, 0);
    assert.equal(febEmp.manualKopecks, 30000);
    assert.equal(febEmp.paidKopecks, 70000);

    // ---- Overpay scenario: paying more than accrued flips the sign. ---------
    const bigPayout = await call('POST', '/api/salaries/payouts', {
      userId: workerId,
      amountKopecks: 600000,
      paidAt: '2026-03-01',
      comment: 'Overpay',
    });
    assert.equal(bigPayout.status, 201, 'overpay payout');
    const summary2 = await call('GET', '/api/salaries/summary');
    const worker2 = (summary2.data as { employees: Array<Record<string, unknown>> }).employees.find(
      (s) => s.id === workerId
    )!;
    assert.equal(worker2.totalPaidKopecks, 670000); // 70000 + 600000
    assert.equal(worker2.remainingKopecks, -190000);
    assert.equal(worker2.overpaidKopecks, 190000, 'overpay reported separately');
  } finally {
    db.close();
  }
});

test('salary admin endpoints are protected from employees and unauthenticated calls', async () => {
  const { db, app, call } = await bootAdmin();
  const injectAs = (cookie: string, csrf: string, method: string, url: string, body?: unknown) =>
    inject(app, method, url, body === undefined ? undefined : JSON.stringify(body), {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrf,
    });

  try {
    // Unauthenticated: 401 on all three admin routes.
    for (const url of ['/api/salaries/summary', '/api/salaries/ledger?userId=x', '/api/salaries/monthly']) {
      const res = await injectAs('', '', 'GET', url);
      assert.equal(res.status, 401, `unauthenticated ${url} → 401`);
    }

    // Create a worker, then log in as that worker.
    const worker = await call('POST', '/api/users', {
      login: 'worker',
      fullName: 'Worker One',
      password: 'long-password-123',
    });
    assert.equal(worker.status, 201, 'create worker');
    const workerId = (worker.data as { user: { id: string } }).user.id;
    const login = await injectAs('', '', 'POST', '/api/auth/login', {
      login: 'worker',
      password: 'long-password-123',
    });
    const workerCookie = login.headers.get('set-cookie')!.split(';')[0];
    const workerCsrf = ((await login.json()) as { csrfToken: string }).csrfToken;

    // Employee (non-admin) is denied 403 on all three.
    for (const url of ['/api/salaries/summary', `/api/salaries/ledger?userId=${workerId}`, '/api/salaries/monthly']) {
      const res = await injectAs(workerCookie, workerCsrf, 'GET', url);
      assert.equal(res.status, 403, `employee ${url} → 403`);
    }

    // Admin succeeds on all three.
    for (const url of ['/api/salaries/summary', `/api/salaries/ledger?userId=${workerId}`, '/api/salaries/monthly']) {
      const res = await call('GET', url);
      assert.equal(res.status, 200, `admin ${url} → 200`);
    }
  } finally {
    db.close();
  }
});
