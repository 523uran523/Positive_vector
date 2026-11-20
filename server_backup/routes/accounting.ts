import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import type { DatabaseSync } from 'node:sqlite';
import { requireAdmin, type AuthedRequest } from '../middleware.ts';
import { writeAuditLog } from '../security.ts';
import { withTransaction } from '../db.ts';

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:12*1024*1024,files:1}});
function folder() { const dir=path.resolve(process.env.UPLOAD_DIR || './data/uploads','accounting'); fs.mkdirSync(dir,{recursive:true,mode:0o700}); return dir; }
function safeName(name:string) {
  const decoded=Buffer.from(name,'latin1').toString('utf8');
  const value=decoded.includes('\uFFFD') ? name : decoded;
  return value.replace(/\\/g,'/').split('/').pop()!.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200) || 'Документ';
}

export function createAccountingRouter(db:DatabaseSync):express.Router {
  const router=express.Router(); router.use(requireAdmin);
  router.use((req:AuthedRequest,res,next)=>{
    if (!req.authUser!.accountingAccess) { res.status(403).json({error:'Доступ к бухгалтерии отключён.'}); return; }
    next();
  });
  router.get('/',(req,res)=>{
    const q=typeof req.query.q==='string' ? req.query.q.trim().toLocaleLowerCase('ru-RU') : '';
    const ascending=req.query.sort==='oldest';
    const rows=db.prepare(`SELECT id,original_name,size_bytes,created_at FROM accounting_documents ORDER BY created_at ${ascending ? 'ASC' : 'DESC'},id ${ascending ? 'ASC' : 'DESC'}`).all() as Array<{id:string;original_name:string;size_bytes:number;created_at:string}>;
    res.json({documents:q ? rows.filter(row=>row.original_name.toLocaleLowerCase('ru-RU').includes(q)) : rows});
  });
  router.post('/',upload.single('file'),(req:AuthedRequest,res)=>{
    if(!req.file){res.status(400).json({error:'Выберите файл.'});return;}
    const id=crypto.randomUUID(),stored=crypto.randomUUID(),name=safeName(req.file.originalname),now=new Date().toISOString();
    const target=path.join(folder(),stored);
    fs.writeFileSync(target,req.file.buffer,{flag:'wx',mode:0o600});
    try {
      withTransaction(db,()=>{
        db.prepare('INSERT INTO accounting_documents(id,original_name,stored_name,size_bytes,uploaded_by,created_at) VALUES (?,?,?,?,?,?)').run(id,name,stored,req.file!.size,req.authUser!.id,now);
        writeAuditLog(db,req.authUser!.id,'accounting_document',id,'accounting_document_uploaded',{});
      });
    } catch(error) { fs.rmSync(target,{force:true});throw error; }
    res.status(201).json({document:{id,original_name:name,size_bytes:req.file.size,created_at:now}});
  });
  router.get('/:id/download',(req,res)=>{
    const row=db.prepare('SELECT original_name,stored_name FROM accounting_documents WHERE id=?').get(String(req.params.id)) as {original_name:string;stored_name:string} | undefined;
    if(!row){res.sendStatus(404);return;}
    if(!/^[0-9a-f-]{36}$/.test(row.stored_name)){res.sendStatus(500);return;}
    res.setHeader('Content-Type','application/octet-stream');
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    res.sendFile(path.join(folder(),row.stored_name));
  });
  return router;
}
