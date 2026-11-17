import crypto from 'node:crypto';
import fs from 'node:fs';
import type express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from './db.ts';
import type { AuthedRequest } from './middleware.ts';
import { sessionSecret } from './config.ts';

const entities: Record<string, string> = {
  '/api/orders': 'orders', '/api/clients/companies': 'companies', '/api/clients/contacts': 'contacts',
  '/api/warehouse/materials': 'materials', '/api/warehouse/tools': 'tools',
  '/api/finance/payments': 'client_payments', '/api/finance/expenses': 'expenses',
};
export function rowVersion(db: DatabaseSync, table: string, id: string): string | null {
  if (![...Object.values(entities), 'visit_reports', 'attachments'].includes(table)) return null;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  return row ? crypto.createHmac('sha256',sessionSecret()).update(JSON.stringify(row)).digest('hex') : null;
}
function target(url: string): { table: string; id: string } | null {
  const reports = url.match(/^\/api\/orders\/[^/]+\/visits\/[^/]+\/reports\/([^/?]+)$/);
  if (reports) return { table:'visit_reports', id:reports[1] };
  const attachment = url.match(/^\/api\/orders\/attachments\/([^/?]+)$/);
  if (attachment) return { table:'attachments', id:attachment[1] };
  for (const [prefix,table] of Object.entries(entities)) {
    if (url.startsWith(prefix+'/')) {
      const id = url.slice(prefix.length+1);
      if (id && !id.includes('/') && !id.includes('?')) return {table,id};
    }
  }
  return null;
}

// Only metadata for rows already present in an authorised response is exposed.
export function addVersions(db: DatabaseSync, data: any): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (data._versions) return data;
  const versions: Record<string,string> = {};
  const collect = (prefix: string, rows: any) => {
    for (const row of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      if (!row?.id) continue;
      const t = target(`${prefix}/${row.id}`);
      const v = t && rowVersion(db,t.table,String(row.id));
      if (v) versions[`${prefix}/${row.id}`]=v;
    }
  };
  for (const [field,prefix] of Object.entries({ orders:'/api/orders', order:'/api/orders', companies:'/api/clients/companies', company:'/api/clients/companies', contacts:'/api/clients/contacts', contact:'/api/clients/contacts', materials:'/api/warehouse/materials', material:'/api/warehouse/materials', tools:'/api/warehouse/tools', tool:'/api/warehouse/tools', payments:'/api/finance/payments', expenses:'/api/finance/expenses' })) collect(prefix,data[field]);
  for(const report of data.visitReports || []) collect(`/api/orders/${report.order_id}/visits/${report.visit_id}/reports`,report);
  for(const order of data.orders || (data.order ? [data.order] : [])) {
    for(const visit of order.visits || []) {
      for(const report of visit.reports || []) collect(`/api/orders/${order.id}/visits/${visit.id}/reports`,report);
      collect('/api/orders/attachments',visit.attachments);
    }
    collect('/api/orders/attachments',order.attachments);
  }
  return {...data,_versions:versions};
}

export function versionResponses(db: DatabaseSync): express.RequestHandler {
  return (_req,res,next) => {
    const json = res.json.bind(res);
    res.json = ((data: unknown) => json(res.statusCode < 400 ? addVersions(db,data) : data)) as typeof res.json;
    next();
  };
}

// All supported mutation handlers finish synchronously after body/upload parsing.
// Response capture keeps the business writes and their replay receipt in one transaction.
export function replaySafeMutations(db: DatabaseSync): express.RequestHandler {
  return (req: AuthedRequest,res,next) => {
    if (!req.authUser || !['POST','PUT','PATCH','DELETE'].includes(req.method) || req.path.startsWith('/api/auth/')) return next();
    if (req.is('multipart/form-data') && !req.file) return next();
    const operationId = req.get('Idempotency-Key');
    if (!operationId) return next();
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(operationId)) { res.status(400).json({error:'Некорректный идентификатор операции.'}); return; }
    const createdAt=Date.parse(req.get('X-Operation-Created-At')||'');
    if(!Number.isFinite(createdAt) || createdAt<Date.now()-30*24*3600_000 || createdAt>Date.now()+5*60_000) {
      res.status(409).json({error:'Срок отправки операции истёк или время устройства неверно. Обновите данные и повторите действие.'});return;
    }
    const actor = req.authUser.id;
    const url = req.originalUrl.split('?')[0];
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({url,method:req.method,scope:{role:req.authUser.role,permissions:req.authUser.permissions},body:req.body,file:req.file ? {name:req.file.originalname,type:req.file.mimetype,hash:crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex')} : null})).digest('hex');
    const saved = db.prepare('SELECT * FROM mutation_receipts WHERE user_id = ? AND operation_id = ?').get(actor,operationId);
    if(saved) {
      res.locals.replayed = true;
      if(saved.request_hash !== fingerprint) { res.status(409).json({error:'Идентификатор уже использован для другой операции.'}); return; }
      res.status(Number(saved.status_code)).json(JSON.parse(String(saved.response_json)));
      return;
    }
    const entity = target(url);
    const originalJson = res.json;
    let payload: any;
    let sent = false;
    res.json = ((value: any) => { payload=value; sent=true; return res; }) as typeof res.json;
    const rejectResponse = new Error('NON_SUCCESS_RESPONSE');
    try {
      withTransaction(db,()=>{
        if (['PATCH','PUT','DELETE'].includes(req.method) && entity) {
          const current = rowVersion(db,entity.table,entity.id);
          if(!current) { res.status(404).json({error:'Запись удалена. Обновите данные и проверьте операцию.'}); throw rejectResponse; }
          if(req.get('If-Match') !== current) { res.status(409).json({error:'Запись изменилась. Обновите данные и внесите правки заново.',code:'VERSION_CONFLICT'}); throw rejectResponse; }
        }
        next();
        if(!sent) throw new Error('Mutation handler did not complete synchronously');
        if(res.statusCode >= 400) throw rejectResponse;
        payload=addVersions(db,payload);
        db.prepare('INSERT INTO mutation_receipts (user_id,operation_id,request_hash,status_code,response_json,created_at) VALUES (?,?,?,?,?,?)').run(actor,operationId,fingerprint,res.statusCode,JSON.stringify(payload),new Date().toISOString());
      });
      res.json=originalJson;
      res.json(payload);
    } catch(error) {
      res.json=originalJson;
      if(error===rejectResponse) { res.json(payload); return; }
      next(error);
    }
  };
}
