import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Package, Pencil, Plus, Trash2, Wrench, X } from 'lucide-react';
import { apiRequest, formatDateTimeRu, formatQty, formatRub, OP_TYPE_LABELS } from '../lib/api';
import type { AuthUser, MaterialItem, Order, ToolItem, WarehouseOp } from '../types/crm';

const TOOL_ICONS = ['🔧', '🔨', '🪛', '🪚', '🪜', '🛠️', '🧰', '⚙️', '🔩', '⛏️', '🪓', '🧲', '🪣', '🔌', '💡', '🔦', '🪝'];

function ToolIconSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select aria-label="Иконка инструмента" value={value} onChange={(event) => onChange(event.target.value)} className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]">
    {!TOOL_ICONS.includes(value) && <option value={value}>{value} (текущая)</option>}
    {TOOL_ICONS.map((icon) => <option key={icon} value={icon}>{icon}</option>)}
  </select>;
}

type BatchDetails = {batches:Array<{id:string;received_qty_milli:number;remaining_qty_milli:number;unit_cost_kopecks:number;estimated:number;created_at:string}>;receipts:Array<{id:string;qty_milli:number;unit_cost_kopecks:number;created_at:string}>;stockQtyMilli:number;averageCostKopecks:number|null;stockValueKopecks:number;purchaseTotalKopecks:number};
function MaterialBatches({material}:{material:MaterialItem}) {
  const [open,setOpen]=useState(false);
  const [details,setDetails]=useState<BatchDetails|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    if(!open) return;
    let active=true;
    void apiRequest<BatchDetails>(`/api/warehouse/materials/${encodeURIComponent(material.id)}/batches`,{useCache:false}).then(data=>{if(active){setDetails(data);setError('');}}).catch(err=>{if(active){setDetails(null);setError(err instanceof Error?err.message:'Ошибка загрузки');}});
    return ()=>{active=false;};
  },[open,material.id,material.quantity_milli]);
  return <div className="mt-3 border-t border-black/5 pt-2 text-xs dark:border-white/10">
    <button type="button" onClick={()=>setOpen(!open)} className="font-semibold text-[#0071E3] dark:text-[#71b5ff]">{open?'Скрыть закупки и партии':'Закупки и партии'}</button>
    {open && error && <p role="alert" className="mt-2 text-red-500">{error}</p>}
    {open && details && <div className="mt-2 space-y-2">
      <p>Средняя цена остатка: {details.averageCostKopecks===null?'нет остатка':`${formatRub(details.averageCostKopecks)} / ${material.unit}`}</p>
      <p>Стоимость остатка: {formatRub(details.stockValueKopecks)} · Закуплено на: {formatRub(details.purchaseTotalKopecks)}</p>
      {details.stockQtyMilli<0 && <p className="text-red-500">Исторический отрицательный остаток: {formatQty(details.stockQtyMilli)} {material.unit}. Пополните склад.</p>}
      <p className="font-semibold">Партии остатка (списание с ранней)</p>
      {details.batches.filter(batch=>batch.remaining_qty_milli>0).map(batch=><div key={batch.id}>{formatQty(batch.remaining_qty_milli)} {material.unit} × {formatRub(batch.unit_cost_kopecks)}{batch.estimated?' · оценка старого остатка':''}</div>)}
      <p className="font-semibold">История поступлений</p>
      {details.receipts.map(receipt=><div key={receipt.id}>{formatDateTimeRu(receipt.created_at)} · {formatQty(receipt.qty_milli)} {material.unit} × {formatRub(receipt.unit_cost_kopecks)} = {formatRub(Math.round(receipt.qty_milli*receipt.unit_cost_kopecks/1000))}</div>)}
      {!details.receipts.length && <p>Поступлений в истории нет.</p>}
    </div>}
  </div>;
}

interface WarehouseViewProps {
  user: AuthUser;
  materials: MaterialItem[];
  tools: ToolItem[];
  operations: WarehouseOp[];
  orders: Order[];
  units: string[];
  categories: string[];
  onRefresh: () => void;
}

export function WarehouseView({
  user,
  materials,
  tools,
  operations,
  orders,
  units,
  categories,
  onRefresh,
}: WarehouseViewProps) {
  const isAdmin = user.role === 'admin';
  const canReceive = isAdmin || user.permissions['warehouse.receive'];
  const canEdit = isAdmin || user.permissions['warehouse.edit'];
  const canTake = isAdmin || user.permissions['warehouse.take'];

  const [tab, setTab] = useState<'materials' | 'tools' | 'history'>('materials');
  const [modal, setModal] = useState<'newMat' | 'editMat' | 'newTool' | 'editTool' | 'matOp' | 'toolOp' | null>(null);
  const [selectedMat, setSelectedMat] = useState<MaterialItem | null>(null);
  const [selectedTool, setSelectedTool] = useState<ToolItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDeleteToolId, setConfirmDeleteToolId] = useState<string | null>(null);
  const [confirmDeleteMat, setConfirmDeleteMat] = useState(false);

  // New / Edit material state
  const [mName, setMName] = useState('');
  const [mCat, setMCat] = useState(categories[0] || 'Прочее');
  const [mUnit, setMUnit] = useState(units[0] || 'шт');
  const [mCustomUnit, setMCustomUnit] = useState('');
  const [mQty, setMQty] = useState('0');
  const [mPriceRub, setMPriceRub] = useState('0');
  const [mThresh, setMThresh] = useState('5');

  // Material operation state
  const [opType, setOpType] = useState<'receipt' | 'issue' | 'consume' | 'return' | 'adjust'>('receipt');
  const [opQty, setOpQty] = useState('1');
  const [opCostRub, setOpCostRub] = useState('');
  const [opNote, setOpNote] = useState('');
  const [opOrderId, setOpOrderId] = useState('');

  // New / Edit tool state
  const [tName, setTName] = useState('');
  const [tEmoji, setTEmoji] = useState('🔧');
  const [tColor, setTColor] = useState('#0071E3');
  const [tMode, setTMode] = useState<'quantity' | 'individual'>('quantity');
  const [tQty, setTQty] = useState('1');
  const [tSerialsText, setTSerialsText] = useState('');
  const [tNotes, setTNotes] = useState('');

  // Tool op state
  const [tOpType, setTOpType] = useState<'issue' | 'return'>('issue');
  const [tInstanceId, setTInstanceId] = useState('');
  const [tOpQty, setTOpQty] = useState('1');
  const [tOpNote, setTOpNote] = useState('');

  const handleCreateMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>('/api/warehouse/materials', {
        method: 'POST',
        body: {
          name: mName,
          category: mCat,
          unit: mCustomUnit.trim() || mUnit,
          initialQtyMilli: Math.round(Number(mQty) * 1000),
          purchasePriceKopecks: Math.round(Number(mPriceRub) * 100),
          minThresholdMilli: Math.round(Number(mThresh) * 1000),
        },
        offlineLabel: `Новый материал «${mName}»`,
      });
      setModal(null);
      setMName('');
      setMCustomUnit('');
      if (res.offlineQueued) {
        setNotice('Создание материала поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления материала');
    } finally {
      setBusy(false);
    }
  };

  const openEditMaterial = (m: MaterialItem) => {
    setSelectedMat(m);
    setMName(m.name);
    setMCat(m.category);
    if (units.includes(m.unit)) {
      setMUnit(m.unit);
      setMCustomUnit('');
    } else {
      setMUnit(units[0] || 'шт');
      setMCustomUnit(m.unit);
    }
    setMPriceRub(String(Math.round(m.purchase_price_kopecks / 100)));
    setMThresh(String(m.min_threshold_milli / 1000));
    setConfirmDeleteMat(false);
    setError('');
    setModal('editMat');
  };

  const handleUpdateMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMat) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/warehouse/materials/${selectedMat.id}`, {
        method: 'PATCH',
        body: {
          name: mName,
          category: mCat,
          unit: mCustomUnit.trim() || mUnit,
          purchasePriceKopecks: Math.round(Number(mPriceRub) * 100),
          minThresholdMilli: Math.round(Number(mThresh) * 1000),
        },
        offlineLabel: `Обновление материала «${mName}»`,
      });
      setModal(null);
      if (res.offlineQueued) {
        setNotice('Изменение материала поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления материала');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteMaterial = async () => {
    if (!selectedMat) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/warehouse/materials/${selectedMat.id}`, {
        method: 'DELETE',
        offlineLabel: `Удаление материала «${selectedMat.name}»`,
      });
      setModal(null);
      setConfirmDeleteMat(false);
      if (res.offlineQueued) {
        setNotice('Удаление материала поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления материала');
    } finally {
      setBusy(false);
    }
  };

  const handleMaterialOp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMat) return;
    const estimatedAfter=opType==='adjust' ? Number(opQty)*1000 : selectedMat.quantity_milli-Number(opQty)*1000;
    const conflict=['issue','consume','adjust'].includes(opType) && (selectedMat.reserved_milli||0)>estimatedAfter;
    const confirmReserved=conflict || (!navigator.onLine && ['issue','consume','adjust'].includes(opType));
    if(confirmReserved && !window.confirm('Материал может быть зарезервирован под другой заказ. Выполнить операцию?')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/warehouse/materials/${selectedMat.id}/operations`, {
        method: 'POST',
        body: {
          opType,
          qtyMilli: Math.round(Number(opQty) * 1000),
          unitCostKopecks: opCostRub ? Math.round(Number(opCostRub) * 100) : undefined,
          note: opNote,
          orderId: ['issue','return'].includes(opType) ? opOrderId : undefined,
          confirmReserved,
        },
        offlineLabel: `Операция по «${selectedMat.name}»`,
      });
      setModal(null);
      setOpNote('');
      if (res.offlineQueued) {
        setNotice('Операция по материалу поставлена в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка операции');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTool = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const serialNumbers =
        tMode === 'individual'
          ? tSerialsText
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const res = await apiRequest<{ offlineQueued?: boolean }>('/api/warehouse/tools', {
        method: 'POST',
        body: {
          name: tName,
          iconEmoji: tEmoji,
          color: tColor,
          trackingMode: tMode,
          totalQty: Number(tQty || 1),
          serialNumbers,
          notes: tNotes,
        },
        offlineLabel: `Новый инструмент «${tName}»`,
      });
      setModal(null);
      setTName('');
      setTSerialsText('');
      setTNotes('');
      if (res.offlineQueued) {
        setNotice('Создание инструмента поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления инструмента');
    } finally {
      setBusy(false);
    }
  };

  const openEditTool = (t: ToolItem) => {
    setSelectedTool(t);
    setTName(t.name);
    setTEmoji(t.icon_emoji);
    setTColor(t.color);
    setTMode(t.tracking_mode);
    setTQty(String(t.total_qty));
    setTSerialsText('');
    setTNotes(t.notes || '');
    setError('');
    setModal('editTool');
  };

  const handleUpdateTool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTool) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const addSerials =
        selectedTool.tracking_mode === 'individual' && tSerialsText.trim()
          ? tSerialsText
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/warehouse/tools/${selectedTool.id}`, {
        method: 'PATCH',
        body: {
          name: tName,
          iconEmoji: tEmoji,
          color: tColor,
          notes: tNotes,
          ...(selectedTool.tracking_mode === 'quantity' ? { totalQty: Number(tQty) } : {}),
          ...(addSerials ? { addSerials } : {}),
        },
        offlineLabel: `Обновление инструмента «${tName}»`,
      });
      setModal(null);
      if (res.offlineQueued) {
        setNotice('Изменения инструмента поставлены в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления инструмента');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTool = async (t: ToolItem) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/warehouse/tools/${t.id}`, {
        method: 'DELETE',
        offlineLabel: `Удаление инструмента «${t.name}»`,
      });
      setConfirmDeleteToolId(null);
      if (res.offlineQueued) {
        setNotice('Удаление инструмента поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления инструмента');
      setConfirmDeleteToolId(null);
    } finally {
      setBusy(false);
    }
  };

  const handleToolOp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTool) return;
    const confirmReserved=tOpType==='issue' && ((selectedTool.reserved_milli||0)>(selectedTool.available_qty-Number(tOpQty||1))*1000 || !navigator.onLine);
    if(confirmReserved && !window.confirm('Инструмент может быть зарезервирован под другой заказ. Выдать его?')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/warehouse/tools/${selectedTool.id}/operations`, {
        method: 'POST',
        body: {
          opType: tOpType,
          toolInstanceId: tInstanceId || undefined,
          qty: Number(tOpQty || 1),
          note: tOpNote,
          confirmReserved,
        },
        offlineLabel: `Операция с «${selectedTool.name}»`,
      });
      setModal(null);
      setTOpNote('');
      setTInstanceId('');
      if (res.offlineQueued) {
        setNotice('Операция с инструментом поставлена в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка операции с инструментом');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && !modal && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          {notice}
        </div>
      )}
      <div className="flex flex-col justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:flex-row sm:items-center dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="flex flex-wrap rounded-xl bg-[#F5F5F7] p-1 dark:bg-[#0B0C10]">
          <button
            type="button"
            onClick={() => setTab('materials')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
              tab === 'materials'
                ? 'bg-white shadow-xs dark:bg-[#15171C]'
                : 'text-zinc-500'
            }`}
          >
            <Package className="h-3.5 w-3.5" />
            <span>Материалы ({materials.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('tools')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
              tab === 'tools' ? 'bg-white shadow-xs dark:bg-[#15171C]' : 'text-zinc-500'
            }`}
          >
            <Wrench className="h-3.5 w-3.5" />
            <span>Инструменты ({tools.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              tab === 'history' ? 'bg-white shadow-xs dark:bg-[#15171C]' : 'text-zinc-500'
            }`}
          >
            Журнал ({operations.length})
          </button>
        </div>

        {(canReceive || canEdit) && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setError('');
                setModal('newMat');
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Материал</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setError('');
                setModal('newTool');
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-black/[0.08] bg-white px-3.5 py-2 text-xs font-semibold hover:bg-zinc-50 dark:border-white/[0.1] dark:bg-[#0B0C10]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Инструмент</span>
            </button>
          </div>
        )}
      </div>

      {tab === 'materials' && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {materials.map((m) => {
            const isNegative = m.quantity_milli < 0;
            const isLow = m.min_threshold_milli > 0 && m.quantity_milli <= m.min_threshold_milli;
            return (
              <div
                key={m.id}
                className="flex flex-col justify-between rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-medium text-zinc-400">{m.category}</div>
                      <h3 className="mt-0.5 font-display text-sm font-bold">{m.name}</h3>
                    </div>
                    {(isNegative || isLow || canEdit) && (
                      <div className="flex items-center gap-1.5">
                        {(isNegative || isLow) && (
                          <span
                            className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                              isNegative ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                            }`}
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {isNegative ? 'Минус!' : 'Мало'}
                          </span>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => openEditMaterial(m)}
                            title="Редактировать материал"
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:text-[#0071E3] dark:border-white/[0.1] dark:text-zinc-400"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex items-baseline justify-between">
                    <div
                      className={`text-2xl font-bold tabular-nums ${
                        isNegative ? 'text-red-600 dark:text-red-400' : ''
                      }`}
                    >
                      {formatQty(m.quantity_milli)}{' '}
                      <span className="text-sm font-medium text-zinc-400">{m.unit}</span>
                    </div>
                    {isAdmin && (
                      <div className="text-xs text-zinc-500 tabular-nums">
                        {formatRub(m.purchase_price_kopecks)} / {m.unit}
                      </div>
                    )}
                  </div>
                  {m.min_threshold_milli > 0 && (
                    <div className="mt-1 text-[11px] text-zinc-400 tabular-nums">
                      Мин. порог: {formatQty(m.min_threshold_milli)} {m.unit}
                    </div>
                  )}
                  {(m.reserved_milli||0)>0 && <p className="mt-1 text-xs text-amber-600">Зарезервировано: {formatQty(m.reserved_milli)} {m.unit} · свободно: {formatQty(Math.max(0,m.quantity_milli-(m.reserved_milli||0)))} {m.unit}</p>}
                  {isAdmin && <MaterialBatches material={m} />}
                </div>

                {(canReceive || canTake || canEdit) && (
                  <div className="mt-4 flex gap-2 border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
                    {canReceive && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMat(m);
                          setOpType('receipt');
                          setOpQty('10');
                          setOpCostRub(String(Math.round(m.purchase_price_kopecks / 100)));
                          setError('');
                          setModal('matOp');
                        }}
                        className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-emerald-500/10 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                      >
                        <ArrowDownLeft className="h-3.5 w-3.5" />
                        <span>Приход</span>
                      </button>
                    )}
                    {canTake && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMat(m);
                          setOpType('consume');
                          setOpQty('1');
                          setOpCostRub('');
                          setError('');
                          setModal('matOp');
                        }}
                        className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-[#0071E3]/10 py-2 text-xs font-semibold text-[#0071E3] hover:bg-[#0071E3]/20 dark:text-[#2997FF]"
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                        <span>Списать / Взять</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'tools' && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {tools.map((t) => (
            <div
              key={t.id}
              className="flex flex-col justify-between rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-lg"
                      style={{ backgroundColor: `${t.color}1F` }}
                    >
                      {t.icon_emoji}
                    </span>
                    <div>
                      <h3 className="font-display text-sm font-bold">{t.name}</h3>
                      <div className="text-[11px] text-zinc-400">
                        {t.tracking_mode === 'individual' ? 'По инвентарным №' : 'Количественный учёт'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <div className="text-lg font-bold tabular-nums">
                        {t.available_qty} / {t.total_qty}
                      </div>
                      <div className="text-[11px] text-zinc-400">на складе</div>
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEditTool(t)}
                          title="Редактировать инструмент"
                          className="flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:text-[#0071E3] dark:border-white/[0.1] dark:text-zinc-400"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {confirmDeleteToolId !== t.id ? (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteToolId(t.id)}
                            title="Удалить инструмент"
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:border-red-500/30 hover:text-red-600 dark:border-white/[0.1] dark:text-zinc-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <div className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px]">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleDeleteTool(t)}
                              className="font-semibold text-red-600"
                            >
                              Удал.
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteToolId(null)}
                              className="text-zinc-500"
                            >
                              Отм.
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {(t.reserved_milli||0)>0 && <p className="mt-2 text-xs text-amber-600">Зарезервировано: {formatQty(t.reserved_milli)} шт · свободно: {formatQty(Math.max(0,t.available_qty*1000-(t.reserved_milli||0)))} шт</p>}
                {t.tracking_mode === 'individual' && t.instances.length > 0 && (
                  <div className="mt-3 space-y-1 border-t border-black/[0.05] pt-2.5 text-xs dark:border-white/[0.06]">
                    {t.instances.map((inst) => (
                      <div key={inst.id} className="flex items-center justify-between">
                        <span className="font-mono font-semibold">#{inst.serial_number}</span>
                        {inst.status === 'available' ? (
                          <span className="text-emerald-600 dark:text-emerald-400">На складе</span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">
                            У {inst.holder_name || 'сотрудника'}
                            {inst.order_number ? ` · ${inst.order_number}` : ''}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {t.tracking_mode === 'quantity' && t.activeHolders.length > 0 && (
                  <div className="mt-3 space-y-1 border-t border-black/[0.05] pt-2.5 text-xs dark:border-white/[0.06]">
                    <div className="text-[11px] text-zinc-400">На руках:</div>
                    {t.activeHolders.map((h) => (
                      <div key={h.userId} className="flex items-center justify-between">
                        <span>{h.holderName}</span>
                        <span className="font-semibold tabular-nums">{h.qty} шт</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {canTake && (
                <div className="mt-4 flex gap-2 border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTool(t);
                      setTOpType('issue');
                      setTInstanceId('');
                      setTOpQty('1');
                      setError('');
                      setModal('toolOp');
                    }}
                    className="flex-1 rounded-xl bg-[#0071E3]/10 py-2 text-xs font-semibold text-[#0071E3] dark:text-[#2997FF]"
                  >
                    Взять
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTool(t);
                      setTOpType('return');
                      setTInstanceId('');
                      setTOpQty('1');
                      setError('');
                      setModal('toolOp');
                    }}
                    className="flex-1 rounded-xl bg-emerald-500/10 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
                  >
                    Вернуть
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'history' && (
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]">
          <div className="space-y-2">
            {operations.map((op) => (
              <div
                key={op.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-black/[0.05] px-3.5 py-2.5 text-xs dark:border-white/[0.06]"
              >
                <div>
                  <span className="font-semibold">
                    {op.material_name || op.tool_name}
                    {op.tool_serial ? ` #${op.tool_serial}` : ''}
                  </span>
                  <span className="mx-1.5 text-zinc-300">·</span>
                  <span className="text-zinc-500">{OP_TYPE_LABELS[op.op_type] || op.op_type}</span>
                  {op.order_number && (
                    <>
                      <span className="mx-1.5 text-zinc-300">·</span>
                      <span className="font-mono text-[#0071E3]">{op.order_number}</span>
                    </>
                  )}
                  {op.employee_name && (
                    <>
                      <span className="mx-1.5 text-zinc-300">·</span>
                      <span className="text-zinc-500">{op.employee_name}</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-3 tabular-nums">
                  <span className="font-bold">
                    {formatQty(op.qty_milli)} {op.material_unit || 'шт'}
                  </span>
                  <span className="text-zinc-400">{formatDateTimeRu(op.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* New Material Modal */}
      {modal === 'newMat' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleCreateMaterial}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Новый материал</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <input
                type="text"
                required
                value={mName}
                onChange={(e) => setMName(e.target.value)}
                placeholder="Название материала *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={mCat}
                  onChange={(e) => setMCat(e.target.value)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  value={mUnit}
                  onChange={(e) => setMUnit(e.target.value)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  {units.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                value={mCustomUnit}
                onChange={(e) => setMCustomUnit(e.target.value)}
                placeholder="Или своя единица (опц., напр. пачка)"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Нач. остаток</label>
                  <input
                    type="number"
                    step="0.1"
                    value={mQty}
                    onChange={(e) => setMQty(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Цена, ₽</label>
                  <input
                    type="number"
                    step="1"
                    value={mPriceRub}
                    onChange={(e) => setMPriceRub(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Мин. порог</label>
                  <input
                    type="number"
                    step="0.1"
                    value={mThresh}
                    onChange={(e) => setMThresh(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Создать материал
            </button>
          </form>
        </div>
      )}

      {/* Edit Material Modal */}
      {modal === 'editMat' && selectedMat && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleUpdateMaterial}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Редактировать материал</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <input
                type="text"
                required
                value={mName}
                onChange={(e) => setMName(e.target.value)}
                placeholder="Название материала *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={mCat}
                  onChange={(e) => setMCat(e.target.value)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  value={mUnit}
                  onChange={(e) => setMUnit(e.target.value)}
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  {units.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                value={mCustomUnit}
                onChange={(e) => setMCustomUnit(e.target.value)}
                placeholder="Или своя единица (опц., напр. пачка)"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Цена закупки, ₽</label>
                  <input
                    type="number"
                    step="1"
                    value={mPriceRub}
                    onChange={(e) => setMPriceRub(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Мин. порог</label>
                  <input
                    type="number"
                    step="0.1"
                    value={mThresh}
                    onChange={(e) => setMThresh(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={busy}
                className="flex-1 rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
              >
                {busy ? 'Сохраняем...' : 'Сохранить изменения'}
              </button>
              {!confirmDeleteMat ? (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteMat(true)}
                  className="rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-600 dark:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDeleteMaterial()}
                  className="rounded-2xl bg-red-600 px-4 py-3 text-xs font-semibold text-white"
                >
                  Удалить точно
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      {/* Material Operation Modal */}
      {modal === 'matOp' && selectedMat && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleMaterialOp}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">{selectedMat.name}</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <select
                value={opType}
                onChange={(e) => setOpType(e.target.value as any)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              >
                {canReceive && <option value="receipt">Приход на склад</option>}
                {canTake && <option value="issue">Выдать / Взять</option>}
                {canTake && <option value="consume">Списать в расход</option>}
                {canTake && <option value="return">Вернуть на склад</option>}
                {canEdit && <option value="adjust">Задать точный остаток</option>}
              </select>
              {['issue','return'].includes(opType) && <label className="block text-sm">Заказ <select required value={opOrderId} onChange={e=>setOpOrderId(e.target.value)} className="mt-1 w-full rounded-xl border border-black/10 bg-white p-2 dark:bg-[#0B0C10]"><option value="">Выберите заказ</option>{orders.map(order=><option key={order.id} value={order.id}>{order.order_number} · {order.title}</option>)}</select></label>}
              <input
                type="number"
                step="0.1"
                required
                value={opQty}
                onChange={(e) => setOpQty(e.target.value)}
                placeholder={`Количество (${selectedMat.unit})`}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              {opType === 'receipt' && (
                <input
                  type="number"
                  value={opCostRub}
                  onChange={(e) => setOpCostRub(e.target.value)}
                  placeholder="Цена закупки за ед., ₽"
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              )}
              <input
                type="text"
                value={opNote}
                onChange={(e) => setOpNote(e.target.value)}
                placeholder="Примечание"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Выполнить
            </button>
          </form>
        </div>
      )}

      {/* New Tool Modal */}
      {modal === 'newTool' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleCreateTool}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Новый инструмент</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <input
                type="text"
                required
                value={tName}
                onChange={(e) => setTName(e.target.value)}
                placeholder="Название (напр. Шуруповёрт Makita) *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <ToolIconSelect value={tEmoji} onChange={setTEmoji} />
                <input
                  type="color"
                  value={tColor}
                  onChange={(e) => setTColor(e.target.value)}
                  className="h-10 w-full rounded-xl border border-black/[0.1] bg-transparent px-1"
                />
              </div>
              <select
                value={tMode}
                onChange={(e) => setTMode(e.target.value as any)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              >
                <option value="quantity">Количественный учёт (шт)</option>
                <option value="individual">По инвентарным номерам (экземпляры)</option>
              </select>
              <input
                type="number"
                min="1"
                value={tQty}
                onChange={(e) => setTQty(e.target.value)}
                placeholder="Количество"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              {tMode === 'individual' && (
                <input
                  type="text"
                  value={tSerialsText}
                  onChange={(e) => setTSerialsText(e.target.value)}
                  placeholder="Серийные номера через запятую (ИНВ-1, ИНВ-2)"
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              )}
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Создать инструмент
            </button>
          </form>
        </div>
      )}

      {/* Edit Tool Modal */}
      {modal === 'editTool' && selectedTool && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleUpdateTool}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Редактировать инструмент</h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <input
                type="text"
                required
                value={tName}
                onChange={(e) => setTName(e.target.value)}
                placeholder="Название инструмента *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <ToolIconSelect value={tEmoji} onChange={setTEmoji} />
                <input
                  type="color"
                  value={tColor}
                  onChange={(e) => setTColor(e.target.value)}
                  className="h-10 w-full rounded-xl border border-black/[0.1] bg-transparent px-1"
                />
              </div>
              {selectedTool.tracking_mode === 'quantity' ? (
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Общее количество на балансе, шт</label>
                  <input
                    type="number"
                    min="0"
                    value={tQty}
                    onChange={(e) => setTQty(e.target.value)}
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Добавить новые инвентарные № (через запятую)</label>
                  <input
                    type="text"
                    value={tSerialsText}
                    onChange={(e) => setTSerialsText(e.target.value)}
                    placeholder="ИНВ-004, ИНВ-005"
                    className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  />
                </div>
              )}
              <input
                type="text"
                value={tNotes}
                onChange={(e) => setTNotes(e.target.value)}
                placeholder="Заметки"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {busy ? 'Сохраняем...' : 'Сохранить инструмент'}
            </button>
          </form>
        </div>
      )}

      {/* Tool Op Modal */}
      {modal === 'toolOp' && selectedTool && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleToolOp}
            className="w-full max-w-md rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {selectedTool.icon_emoji} {selectedTool.name}
              </h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <select
                value={tOpType}
                onChange={(e) => setTOpType(e.target.value as any)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              >
                <option value="issue">Взять инструмент</option>
                <option value="return">Вернуть на склад</option>
              </select>
              {selectedTool.tracking_mode === 'individual' ? (
                <select
                  required={tOpType === 'return'}
                  value={tInstanceId}
                  onChange={(e) => setTInstanceId(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="">Выберите экземпляр</option>
                  {selectedTool.instances
                    .filter((i) =>
                      tOpType === 'issue' ? i.status === 'available' : i.status === 'issued'
                    )
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        #{i.serial_number} {i.holder_name ? `(${i.holder_name})` : ''}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  type="number"
                  min="1"
                  value={tOpQty}
                  onChange={(e) => setTOpQty(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              )}
              <input
                type="text"
                value={tOpNote}
                onChange={(e) => setTOpNote(e.target.value)}
                placeholder="Примечание"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              Подтвердить
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
