import React, { useEffect, useState } from 'react';
import {
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  FileText,
  Image as ImageIcon,
  List,
  MapPin,
  MessageSquare,
  Package,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  UserCheck,
  Wrench,
  X,
} from 'lucide-react';
import {
  apiRequest,
  formatDateRu,
  formatDateTimeRu,
  formatDuration,
  formatQty,
  formatRub,
  OP_TYPE_LABELS,
  ORDER_STATUS_META,
  PAYMENT_TYPE_LABELS,
} from '../lib/api';
import { getMapHref, getTelHref } from '../lib/links';
import { uploadWithRetry } from '../lib/upload';
import type {
  AuthUser,
  Company,
  Contact,
  DirectoryUser,
  MaterialItem,
  Order,
  OrderPayment,
  ToolItem,
} from '../types/crm';

interface CreateOrderModalProps {
  open: boolean;
  defaultDate?: string;
  defaultCompanyId?: string;
  defaultContactId?: string;
  user: AuthUser;
  directory: DirectoryUser[];
  companies: Company[];
  contacts: Contact[];
  materials: MaterialItem[];
  tools: ToolItem[];
  availableTags: string[];
  onClose: () => void;
  onRefreshWorkspace?: () => void;
  onCreated: (order: Order) => void;
}

export function CreateOrderModal({
  open,
  defaultDate,
  defaultCompanyId,
  defaultContactId,
  user,
  directory,
  companies,
  contacts,
  materials,
  tools,
  availableTags,
  onClose,
  onRefreshWorkspace,
  onCreated,
}: CreateOrderModalProps) {
  const isAdmin = user.role === 'admin';
  const canCreateClient = isAdmin || Boolean(user.permissions['clients.create'] || user.permissions['orders.create']);
  const canCreateWarehouseItem = isAdmin || Boolean(user.permissions['warehouse.edit'] || user.permissions['warehouse.receive']);

  const [localCompanies, setLocalCompanies] = useState<Company[]>(companies);
  const [localContacts, setLocalContacts] = useState<Contact[]>(contacts);
  const [localMaterials, setLocalMaterials] = useState<MaterialItem[]>(materials);
  const [localTools, setLocalTools] = useState<ToolItem[]>(tools);
  const [localTags, setLocalTags] = useState<string[]>(availableTags);

  useEffect(() => { setLocalCompanies(companies); }, [companies]);
  useEffect(() => { setLocalContacts(contacts); }, [contacts]);
  useEffect(() => { setLocalMaterials(materials); }, [materials]);
  useEffect(() => { setLocalTools(tools); }, [tools]);
  useEffect(() => { setLocalTags(availableTags); }, [availableTags]);

  const [title, setTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState(defaultDate ? `${defaultDate}T10:00` : '');
  const [unplanned, setUnplanned] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [clientContactId, setClientContactId] = useState('');
  const [siteContactName, setSiteContactName] = useState('');
  const [siteContactPhone, setSiteContactPhone] = useState('');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [priceRub, setPriceRub] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [visits, setVisits] = useState<Array<{ title: string; scheduledAt: string; description: string }>>([]);
  const [plannedMaterials, setPlannedMaterials] = useState<Array<{ materialId: string; qty: string }>>([]);
  const [plannedTools, setPlannedTools] = useState<Array<{ toolId: string; qty: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Uniform input mode ('search' vs 'list') & live substring search / quick-create states
  const [companyInputMode, setCompanyInputMode] = useState<'search' | 'list'>('search');
  const [contactInputMode, setContactInputMode] = useState<'search' | 'list'>('search');
  const [tagInputMode, setTagInputMode] = useState<'search' | 'list'>('search');
  const [materialInputMode, setMaterialInputMode] = useState<'search' | 'list'>('search');
  const [toolInputMode, setToolInputMode] = useState<'search' | 'list'>('search');

  const [companyQuery, setCompanyQuery] = useState('');
  const [contactQuery, setContactQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [assigneeQuery, setAssigneeQuery] = useState('');
  const [materialQuery, setMaterialQuery] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [quickAdd, setQuickAdd] = useState<'company' | 'contact' | 'tag' | 'material' | 'tool' | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);

  const [qcName, setQcName] = useState('');
  const [qcPhone, setQcPhone] = useState('');
  const [qcAddress, setQcAddress] = useState('');

  const [qctName, setQctName] = useState('');
  const [qctPhone, setQctPhone] = useState('');
  const [qctPos, setQctPos] = useState('');

  const [qTagName, setQTagName] = useState('');

  const [qmName, setQmName] = useState('');
  const [qmUnit, setQmUnit] = useState('шт');
  const [qmQty, setQmQty] = useState('');
  const [qmPriceRub, setQmPriceRub] = useState('');

  const [qtName, setQtName] = useState('');
  const [qtMode, setQtMode] = useState<'quantity' | 'individual'>('quantity');
  const [qtQty, setQtQty] = useState('1');

  useEffect(() => {
    if (open) {
      setScheduledAt(defaultDate ? `${defaultDate}T10:00` : '');
      setUnplanned(!defaultDate);
      setCompanyId(defaultCompanyId || '');
      setClientContactId(defaultContactId || '');
      setCompanyQuery('');
      setContactQuery('');
      setTagQuery('');
      setAssigneeQuery('');
      setMaterialQuery('');
      setToolQuery('');
      setQuickAdd(null);
      setError('');
    }
  }, [open, defaultDate, defaultCompanyId, defaultContactId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const filteredContacts = companyId
    ? localContacts.filter((c) => c.company_id === companyId)
    : localContacts;

  const matchingCompanies = companyQuery.trim()
    ? localCompanies.filter((c) => c.name.toLowerCase().includes(companyQuery.trim().toLowerCase())).slice(0, 6)
    : [];

  const matchingContacts = contactQuery.trim()
    ? filteredContacts
        .filter((ct) =>
          `${ct.full_name} ${ct.phone || ''}`.toLowerCase().includes(contactQuery.trim().toLowerCase())
        )
        .slice(0, 6)
    : [];

  const matchingTags = tagQuery.trim()
    ? localTags
        .filter((t) => !selectedTags.includes(t) && t.toLowerCase().includes(tagQuery.trim().toLowerCase()))
        .slice(0, 6)
    : [];

  const filteredDirectory = assigneeQuery.trim()
    ? directory.filter((emp) => emp.fullName.toLowerCase().includes(assigneeQuery.trim().toLowerCase()))
    : directory;

  const matchingMaterials = materialQuery.trim()
    ? localMaterials
        .filter(
          (m) =>
            !plannedMaterials.some((p) => p.materialId === m.id) &&
            m.name.toLowerCase().includes(materialQuery.trim().toLowerCase())
        )
        .slice(0, 6)
    : [];

  const matchingTools = toolQuery.trim()
    ? localTools
        .filter((t) => t.name.toLowerCase().includes(toolQuery.trim().toLowerCase()))
        .slice(0, 6)
    : [];

  const selectedCompany = companyId ? localCompanies.find((c) => c.id === companyId) : undefined;
  const selectedContact = clientContactId ? localContacts.find((c) => c.id === clientContactId) : undefined;

  const handleQuickCreateCompany = async () => {
    if (!qcName.trim()) {
      setError('Укажите название компании.');
      return;
    }
    setQuickBusy(true);
    setError('');
    try {
      const res = await apiRequest<{ company: Company }>('/api/clients/companies', {
        method: 'POST',
        skipOfflineQueue: true,
        body: { name: qcName.trim(), phone: qcPhone.trim(), address: qcAddress.trim() },
      });
      setLocalCompanies((prev) => [res.company, ...prev]);
      setCompanyId(res.company.id);
      setClientContactId('');
      if (!address.trim() && res.company.address) {
        setAddress(res.company.address);
      }
      setCompanyQuery('');
      setQcName('');
      setQcPhone('');
      setQcAddress('');
      setQuickAdd(null);
      onRefreshWorkspace?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания компании');
    } finally {
      setQuickBusy(false);
    }
  };

  const handleQuickCreateContact = async () => {
    if (!qctName.trim()) {
      setError('Укажите ФИО контакта.');
      return;
    }
    setQuickBusy(true);
    setError('');
    try {
      const res = await apiRequest<{ contact: Contact }>('/api/clients/contacts', {
        method: 'POST',
        skipOfflineQueue: true,
        body: {
          companyId: companyId || null,
          fullName: qctName.trim(),
          phone: qctPhone.trim(),
          position: qctPos.trim(),
        },
      });
      setLocalContacts((prev) => [res.contact, ...prev]);
      setClientContactId(res.contact.id);
      setContactQuery('');
      setQctName('');
      setQctPhone('');
      setQctPos('');
      setQuickAdd(null);
      onRefreshWorkspace?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания контакта');
    } finally {
      setQuickBusy(false);
    }
  };

  const handleQuickCreateMaterial = async () => {
    if (!qmName.trim()) {
      setError('Укажите название материала.');
      return;
    }
    setQuickBusy(true);
    setError('');
    try {
      const qtyNum = Number(qmQty || 0);
      const priceNum = Number(qmPriceRub || 0);
      const res = await apiRequest<{ material: MaterialItem }>('/api/warehouse/materials', {
        method: 'POST',
        skipOfflineQueue: true,
        body: {
          name: qmName.trim(),
          unit: qmUnit.trim() || 'шт',
          initialQtyMilli: qtyNum > 0 ? Math.round(qtyNum * 1000) : 0,
          purchasePriceKopecks: priceNum > 0 ? Math.round(priceNum * 100) : 0,
        },
      });
      const created: MaterialItem = { ...res.material, reserved_milli: 0 };
      setLocalMaterials((prev) => [created, ...prev]);
      setPlannedMaterials((prev) => [...prev, { materialId: created.id, qty: '1' }]);
      setMaterialQuery('');
      setQmName('');
      setQmQty('');
      setQmPriceRub('');
      setQuickAdd(null);
      onRefreshWorkspace?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания материала');
    } finally {
      setQuickBusy(false);
    }
  };

  const handleQuickCreateTool = async () => {
    if (!qtName.trim()) {
      setError('Укажите название инструмента.');
      return;
    }
    setQuickBusy(true);
    setError('');
    try {
      const totalQty = Math.max(1, Math.round(Number(qtQty || 1)));
      const res = await apiRequest<{ tool: ToolItem }>('/api/warehouse/tools', {
        method: 'POST',
        skipOfflineQueue: true,
        body: {
          name: qtName.trim(),
          trackingMode: qtMode,
          totalQty,
        },
      });
      const created: ToolItem = {
        ...res.tool,
        instances: res.tool.instances || [],
        reserved_milli: 0,
      };
      setLocalTools((prev) => [created, ...prev]);
      setPlannedTools((prev) => [...prev, { toolId: created.id, qty: '1' }]);
      setToolQuery('');
      setQtName('');
      setQtQty('1');
      setQuickAdd(null);
      onRefreshWorkspace?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания инструмента');
    } finally {
      setQuickBusy(false);
    }
  };

  const handleQuickCreateTag = async () => {
    const clean = qTagName.trim();
    if (!clean) {
      setError('Укажите название тега.');
      return;
    }
    setQuickBusy(true);
    setError('');
    try {
      const nextTags = Array.from(new Set([...localTags, clean]));
      setLocalTags(nextTags);
      setSelectedTags((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
      if (isAdmin) {
        await apiRequest('/api/settings', {
          method: 'PUT',
          skipOfflineQueue: true,
          body: { order_tags: nextTags },
        });
        onRefreshWorkspace?.();
      }
      setQTagName('');
      setTagQuery('');
      setQuickAdd(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления тега');
    } finally {
      setQuickBusy(false);
    }
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const toggleAssignee = (id: string) => {
    setAssigneeIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const effectiveScheduled = unplanned ? null : scheduledAt || null;
      const effectiveVisits = visits
        .filter((v) => v.scheduledAt)
        .map((v) => ({
          title: v.title || 'Монтажный выезд',
          scheduledAt: v.scheduledAt,
          description: v.description,
          assigneeIds,
        }));

      // If user scheduled a date & assignees without manually adding extra visits, create 1 main visit automatically so workflow works smoothly
      if (effectiveScheduled && effectiveVisits.length === 0 && assigneeIds.length > 0) {
        effectiveVisits.push({
          title: 'Основной выезд / монтаж',
          scheduledAt: effectiveScheduled,
          description: '',
          assigneeIds,
        });
      }

      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>('/api/orders', {
        method: 'POST',
        body: {
          title: title.trim() || undefined,
          scheduledAt: effectiveScheduled,
          companyId: companyId || null,
          clientContactId: clientContactId || null,
          siteContactName,
          siteContactPhone,
          address,
          description,
          priceKopecks: isAdmin && priceRub ? Math.round(Number(priceRub) * 100) : 0,
          tags: selectedTags,
          assigneeIds,
          visits: effectiveVisits,
          plannedMaterials: plannedMaterials
            .filter((m) => m.materialId && Number(m.qty) > 0)
            .map((m) => ({ materialId: m.materialId, qtyMilli: Math.round(Number(m.qty) * 1000) })),
          plannedTools: plannedTools
            .filter((t) => t.toolId && Number(t.qty) > 0)
            .map((t) => ({ toolId: t.toolId, qty: Math.round(Number(t.qty)) })),
        },
        offlineLabel: `Создание заказа «${title.trim() || 'Новый заказ'}»`,
      });
      if (res.order) {
        onCreated(res.order);
      }
      setTitle('');
      setCompanyId('');
      setClientContactId('');
      setSiteContactName('');
      setSiteContactPhone('');
      setAddress('');
      setDescription('');
      setPriceRub('');
      setSelectedTags([]);
      setAssigneeIds([]);
      setVisits([]);
      setPlannedMaterials([]);
      setPlannedTools([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания заказа');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-black/[0.08] bg-white p-5 shadow-2xl sm:rounded-3xl sm:p-6 dark:border-white/[0.1] dark:bg-[#15171C]">
        <div className="sticky top-0 z-10 -mx-5 -mt-5 mb-4 flex items-center justify-between border-b border-black/[0.06] bg-white/95 px-5 py-4 backdrop-blur-md sm:-mx-6 sm:-mt-6 sm:px-6 dark:border-white/[0.08] dark:bg-[#15171C]/95">
          <h2 className="font-display text-xl font-bold">Новый заказ</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть создание заказа"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/[0.05] text-zinc-500 hover:text-zinc-800 dark:bg-white/[0.06] dark:text-zinc-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
              Название заказа *
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например: Фасадный баннер 5×3 м"
              className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none focus:border-[#0071E3] focus:bg-white dark:focus:bg-[#0B0C10] dark:border-white/[0.12] dark:bg-[#0B0C10]"
            />
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Дата и время
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-500">
                  <input
                    type="checkbox"
                    checked={unplanned}
                    onChange={(e) => setUnplanned(e.target.checked)}
                    className="accent-[#0071E3]"
                  />
                  <span>Не запланирован</span>
                </label>
              </div>
              <input
                type="datetime-local"
                disabled={unplanned}
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none disabled:opacity-45 dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>

          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                Компания
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCompanyInputMode((prev) => (prev === 'search' ? 'list' : 'search'))}
                  title={companyInputMode === 'search' ? 'Поиск по имени (нажмите для списка)' : 'Выпадающий список (нажмите для поиска)'}
                  aria-label={companyInputMode === 'search' ? 'Открыть список компаний' : 'Переключить на поиск компании'}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 text-zinc-600 transition hover:border-[#0071E3] hover:text-[#0071E3] dark:border-white/[0.12] dark:bg-[#0B0C10] dark:text-zinc-300"
                >
                  {companyInputMode === 'search' ? <Search className="h-4 w-4" /> : <List className="h-4 w-4" />}
                </button>
                {companyInputMode === 'search' ? (
                  <input
                    type="text"
                    value={companyQuery}
                    onChange={(e) => setCompanyQuery(e.target.value)}
                    placeholder="Поиск компании по названию..."
                    className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white px-3 text-xs outline-none focus:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10]"
                  />
                ) : (
                  <select
                    aria-label="Выбор компании из списка"
                    value={companyId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setCompanyId(nextId);
                      setClientContactId('');
                      const selected = localCompanies.find((c) => c.id === nextId);
                      if (selected && !address.trim() && selected.address) {
                        setAddress(selected.address);
                      }
                    }}
                    className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 text-xs outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  >
                    <option value="">— Не выбрана —</option>
                    {localCompanies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
                {canCreateClient && (
                  <button
                    type="button"
                    aria-label="Добавить компанию"
                    title="Создать новую компанию"
                    onClick={() => setQuickAdd((prev) => (prev === 'company' ? null : 'company'))}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#0071E3]/30 bg-[#0071E3]/10 text-[#0071E3] transition hover:bg-[#0071E3]/15 dark:border-[#2997FF]/30 dark:text-[#2997FF]"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}
              </div>
              {companyInputMode === 'search' && matchingCompanies.length > 0 && (
                <div className="mt-1.5 max-h-28 overflow-y-auto rounded-xl border border-black/[0.08] bg-white p-1 dark:border-white/[0.1] dark:bg-[#0B0C10]">
                  {matchingCompanies.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setCompanyId(c.id);
                        setClientContactId('');
                        setCompanyQuery('');
                        if (!address.trim() && c.address) setAddress(c.address);
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[#0071E3]/10 hover:text-[#0071E3]"
                    >
                      <span className="truncate font-medium">{c.name}</span>
                      {c.phone && <span className="ml-2 shrink-0 text-[11px] text-zinc-400">{c.phone}</span>}
                    </button>
                  ))}
                </div>
              )}
              {companyInputMode === 'search' && selectedCompany && (
                <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg bg-[#0071E3]/10 px-2.5 py-1 text-xs font-medium text-[#0071E3] dark:text-[#2997FF]">
                  <span className="truncate">{selectedCompany.name}</span>
                  <button
                    type="button"
                    aria-label="Снять выбор компании"
                    onClick={() => {
                      setCompanyId('');
                      setClientContactId('');
                    }}
                    className="shrink-0 rounded p-0.5 hover:bg-black/[0.08] dark:hover:bg-white/[0.1]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {quickAdd === 'company' && (
                <div className="mt-2 space-y-2 rounded-xl border border-[#0071E3]/30 bg-[#0071E3]/[0.04] p-3">
                  <div className="text-[11px] font-semibold text-[#0071E3] dark:text-[#2997FF]">Новая компания</div>
                  <input
                    type="text"
                    value={qcName}
                    onChange={(e) => setQcName(e.target.value)}
                    placeholder="Название компании *"
                    className="w-full rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    <input
                      type="tel"
                      value={qcPhone}
                      onChange={(e) => setQcPhone(e.target.value)}
                      placeholder="Телефон"
                      className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                    />
                    <input
                      type="text"
                      value={qcAddress}
                      onChange={(e) => setQcAddress(e.target.value)}
                      placeholder="Адрес"
                      className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                    />
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={quickBusy}
                      onClick={() => void handleQuickCreateCompany()}
                      className="rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      Сохранить и выбрать
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickAdd(null)}
                      className="rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1]"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                Контакт клиента
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setContactInputMode((prev) => (prev === 'search' ? 'list' : 'search'))}
                  title={contactInputMode === 'search' ? 'Поиск по имени (нажмите для списка)' : 'Выпадающий список (нажмите для поиска)'}
                  aria-label={contactInputMode === 'search' ? 'Открыть список контактов' : 'Переключить на поиск контакта'}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 text-zinc-600 transition hover:border-[#0071E3] hover:text-[#0071E3] dark:border-white/[0.12] dark:bg-[#0B0C10] dark:text-zinc-300"
                >
                  {contactInputMode === 'search' ? <Search className="h-4 w-4" /> : <List className="h-4 w-4" />}
                </button>
                {contactInputMode === 'search' ? (
                  <input
                    type="text"
                    value={contactQuery}
                    onChange={(e) => setContactQuery(e.target.value)}
                    placeholder="Поиск контакта по имени или телефону..."
                    className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white px-3 text-xs outline-none focus:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10]"
                  />
                ) : (
                  <select
                    aria-label="Выбор контакта из списка"
                    value={clientContactId}
                    onChange={(e) => setClientContactId(e.target.value)}
                    className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 text-xs outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
                  >
                    <option value="">— Не выбран —</option>
                    {filteredContacts.map((ct) => (
                      <option key={ct.id} value={ct.id}>
                        {ct.full_name} {ct.phone ? `(${ct.phone})` : ''}
                      </option>
                    ))}
                  </select>
                )}
                {canCreateClient && (
                  <button
                    type="button"
                    aria-label="Добавить контакт"
                    title="Создать новый контакт"
                    onClick={() => setQuickAdd((prev) => (prev === 'contact' ? null : 'contact'))}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#0071E3]/30 bg-[#0071E3]/10 text-[#0071E3] transition hover:bg-[#0071E3]/15 dark:border-[#2997FF]/30 dark:text-[#2997FF]"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}
              </div>
              {contactInputMode === 'search' && matchingContacts.length > 0 && (
                <div className="mt-1.5 max-h-28 overflow-y-auto rounded-xl border border-black/[0.08] bg-white p-1 dark:border-white/[0.1] dark:bg-[#0B0C10]">
                  {matchingContacts.map((ct) => (
                    <button
                      key={ct.id}
                      type="button"
                      onClick={() => {
                        setClientContactId(ct.id);
                        setContactQuery('');
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[#0071E3]/10 hover:text-[#0071E3]"
                    >
                      <span className="truncate font-medium">{ct.full_name}</span>
                      {ct.phone && <span className="ml-2 shrink-0 text-[11px] text-zinc-400">{ct.phone}</span>}
                    </button>
                  ))}
                </div>
              )}
              {contactInputMode === 'search' && selectedContact && (
                <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg bg-[#0071E3]/10 px-2.5 py-1 text-xs font-medium text-[#0071E3] dark:text-[#2997FF]">
                  <span className="truncate">
                    {selectedContact.full_name}
                    {selectedContact.phone ? ` (${selectedContact.phone})` : ''}
                  </span>
                  <button
                    type="button"
                    aria-label="Снять выбор контакта"
                    onClick={() => setClientContactId('')}
                    className="shrink-0 rounded p-0.5 hover:bg-black/[0.08] dark:hover:bg-white/[0.1]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {quickAdd === 'contact' && (
                <div className="mt-2 space-y-2 rounded-xl border border-[#0071E3]/30 bg-[#0071E3]/[0.04] p-3">
                  <div className="text-[11px] font-semibold text-[#0071E3] dark:text-[#2997FF]">Новый контакт</div>
                  <input
                    type="text"
                    value={qctName}
                    onChange={(e) => setQctName(e.target.value)}
                    placeholder="ФИО *"
                    className="w-full rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    <input
                      type="tel"
                      value={qctPhone}
                      onChange={(e) => setQctPhone(e.target.value)}
                      placeholder="Телефон"
                      className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                    />
                    <input
                      type="text"
                      value={qctPos}
                      onChange={(e) => setQctPos(e.target.value)}
                      placeholder="Должность"
                      className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                    />
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={quickBusy}
                      onClick={() => void handleQuickCreateContact()}
                      className="rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      Сохранить и выбрать
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickAdd(null)}
                      className="rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1]"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <details className="rounded-2xl border border-black/[0.08] dark:border-white/[0.12]">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[#0071E3] dark:text-[#71b5ff]">
              Дополнительно: объект, стоимость, исполнители и ресурсы
            </summary>
            <div className="space-y-4 px-4 pb-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                Контакт на объекте
              </label>
              <input
                type="text"
                value={siteContactName}
                onChange={(e) => setSiteContactName(e.target.value)}
                placeholder="Имя или пост охраны"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                Телефон на объекте
              </label>
              <input
                type="tel"
                value={siteContactPhone}
                onChange={(e) => setSiteContactPhone(e.target.value)}
                placeholder="+7 ..."
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className={isAdmin ? 'sm:col-span-2' : 'sm:col-span-3'}>
              <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                Адрес объекта
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Улица, дом, вход/этаж"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            {isAdmin && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Стоимость, ₽
                </label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={priceRub}
                  onChange={(e) => setPriceRub(e.target.value)}
                  placeholder="0"
                  className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm tabular-nums outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-zinc-600 dark:text-zinc-300">
              Описание и комментарии
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Размеры конструкции, требования к крепежу, время доступа..."
              className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
            />
          </div>

          {/* Tags */}
          <div>
            <div className="mb-1.5 text-xs font-semibold text-zinc-600 dark:text-zinc-300">Теги</div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setTagInputMode((prev) => (prev === 'search' ? 'list' : 'search'))}
                title={tagInputMode === 'search' ? 'Поиск по названию (нажмите для списка)' : 'Выпадающий список (нажмите для поиска)'}
                aria-label={tagInputMode === 'search' ? 'Открыть список тегов' : 'Переключить на поиск тегов'}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 text-zinc-600 transition hover:border-[#0071E3] hover:text-[#0071E3] dark:border-white/[0.12] dark:bg-[#0B0C10] dark:text-zinc-300"
              >
                {tagInputMode === 'search' ? <Search className="h-4 w-4" /> : <List className="h-4 w-4" />}
              </button>
              {tagInputMode === 'search' ? (
                <input
                  type="text"
                  value={tagQuery}
                  onChange={(e) => setTagQuery(e.target.value)}
                  placeholder="Поиск тега..."
                  className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white px-3 text-xs outline-none focus:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10]"
                />
              ) : (
                <select
                  aria-label="Выбор тега из списка"
                  value=""
                  onChange={(e) => {
                    const nextTag = e.target.value;
                    if (!nextTag) return;
                    setSelectedTags((prev) => (prev.includes(nextTag) ? prev : [...prev, nextTag]));
                  }}
                  className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 text-xs outline-none dark:border-white/[0.12] dark:bg-[#0B0C10]"
                >
                  <option value="">— Выбрать тег —</option>
                  {localTags
                    .filter((t) => !selectedTags.includes(t))
                    .map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                </select>
              )}
              <button
                type="button"
                aria-label="Добавить тег"
                title="Создать новый тег"
                onClick={() => setQuickAdd((prev) => (prev === 'tag' ? null : 'tag'))}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#0071E3]/30 bg-[#0071E3]/10 text-[#0071E3] transition hover:bg-[#0071E3]/15 dark:border-[#2997FF]/30 dark:text-[#2997FF]"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {tagInputMode === 'search' && matchingTags.length > 0 && (
              <div className="mt-1.5 max-h-28 overflow-y-auto rounded-xl border border-black/[0.08] bg-white p-1 dark:border-white/[0.1] dark:bg-[#0B0C10]">
                {matchingTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      setSelectedTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
                      setTagQuery('');
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs font-medium hover:bg-[#0071E3]/10 hover:text-[#0071E3]"
                  >
                    <span>{tag}</span>
                  </button>
                ))}
              </div>
            )}
            {quickAdd === 'tag' && (
              <div className="mt-2 space-y-2 rounded-xl border border-[#0071E3]/30 bg-[#0071E3]/[0.04] p-3">
                <div className="text-[11px] font-semibold text-[#0071E3] dark:text-[#2997FF]">Новый тег</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="text"
                    value={qTagName}
                    onChange={(e) => setQTagName(e.target.value)}
                    placeholder="Название тега *"
                    className="min-w-[160px] flex-1 rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                  />
                  <button
                    type="button"
                    disabled={quickBusy}
                    onClick={() => void handleQuickCreateTag()}
                    className="rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Сохранить и выбрать
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickAdd(null)}
                    className="rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1]"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
            {selectedTags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#0071E3] px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 dark:bg-[#2997FF] dark:text-[#0B0C10]"
                  >
                    <span>{tag}</span>
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Assignees */}
          <div>
            <div className="mb-1.5 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
              Назначенные монтажники
            </div>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={assigneeQuery}
                onChange={(e) => setAssigneeQuery(e.target.value)}
                placeholder="Поиск монтажника по имени..."
                className={`h-9 w-full rounded-xl border border-black/[0.08] bg-white pl-8 text-xs outline-none focus:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#0B0C10] ${
                  assigneeQuery ? 'pr-8' : 'pr-3'
                }`}
              />
              {assigneeQuery && (
                <button
                  type="button"
                  aria-label="Очистить поиск монтажника"
                  onClick={() => setAssigneeQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {filteredDirectory.length === 0 ? (
                <span className="text-xs text-zinc-400">Монтажники не найдены</span>
              ) : (
                filteredDirectory.map((emp) => {
                  const active = assigneeIds.includes(emp.id);
                  return (
                    <button
                      key={emp.id}
                      type="button"
                      onClick={() => toggleAssignee(emp.id)}
                      className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                        active
                          ? 'border-[#0071E3] bg-[#0071E3]/10 text-[#0071E3] dark:border-[#2997FF] dark:text-[#2997FF]'
                          : 'border-black/[0.08] bg-transparent text-zinc-600 hover:bg-black/[0.03] dark:border-white/[0.1] dark:text-zinc-300'
                      }`}
                    >
                      {emp.fullName}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Multi-day visits */}
          <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7]/60 p-3.5 dark:border-white/[0.08] dark:bg-[#0B0C10]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                Многодневные выезды (опционально)
              </span>
              <button
                type="button"
                onClick={() =>
                  setVisits((prev) => [
                    ...prev,
                    {
                      title: `День ${prev.length + 1}`,
                      scheduledAt: defaultDate ? `${defaultDate}T10:00` : '',
                      description: '',
                    },
                  ])
                }
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#0071E3] hover:underline dark:text-[#2997FF]"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Добавить выезд</span>
              </button>
            </div>
            {visits.length > 0 && (
              <div className="mt-2.5 space-y-2">
                {visits.map((v, idx) => (
                  <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <input
                      type="text"
                      value={v.title}
                      onChange={(e) => {
                        const next = [...visits];
                        next[idx].title = e.target.value;
                        setVisits(next);
                      }}
                      placeholder="Этап"
                      className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs sm:col-span-5 dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                    <input
                      type="datetime-local"
                      value={v.scheduledAt}
                      onChange={(e) => {
                        const next = [...visits];
                        next[idx].scheduledAt = e.target.value;
                        setVisits(next);
                      }}
                      className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs sm:col-span-6 dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                    <button
                      type="button"
                      onClick={() => setVisits(visits.filter((_, i) => i !== idx))}
                      className="flex items-center justify-center rounded-xl text-zinc-400 hover:text-red-500 sm:col-span-1"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Scenario A: Planned materials & tools */}
          <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7]/60 p-3.5 dark:border-white/[0.08] dark:bg-[#0B0C10]">
            <div className="mb-2.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              Материалы и инструменты для заказа
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">Материалы</div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMaterialInputMode((prev) => (prev === 'search' ? 'list' : 'search'))}
                    title={materialInputMode === 'search' ? 'Поиск по названию (нажмите для списка)' : 'Выпадающий список (нажмите для поиска)'}
                    aria-label={materialInputMode === 'search' ? 'Открыть список материалов' : 'Переключить на поиск материалов'}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.1] bg-white text-zinc-600 transition hover:border-[#0071E3] hover:text-[#0071E3] dark:border-white/[0.12] dark:bg-[#15171C] dark:text-zinc-300"
                  >
                    {materialInputMode === 'search' ? <Search className="h-4 w-4" /> : <List className="h-4 w-4" />}
                  </button>
                  {materialInputMode === 'search' ? (
                    <input
                      type="text"
                      value={materialQuery}
                      onChange={(e) => setMaterialQuery(e.target.value)}
                      placeholder="Поиск материала по названию..."
                      className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white px-3 text-xs outline-none focus:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                  ) : (
                    <select
                      aria-label="Выбор материала из списка"
                      value=""
                      onChange={(e) => {
                        const matId = e.target.value;
                        if (!matId) return;
                        setPlannedMaterials((prev) => [...prev, { materialId: matId, qty: '1' }]);
                      }}
                      className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.1] bg-white px-3 text-xs outline-none dark:border-white/[0.12] dark:bg-[#15171C]"
                    >
                      <option value="">— Выбрать материал —</option>
                      {localMaterials
                        .filter((m) => !plannedMaterials.some((p) => p.materialId === m.id))
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({formatQty(Math.max(0, m.quantity_milli - (m.reserved_milli || 0)))} {m.unit})
                          </option>
                        ))}
                    </select>
                  )}
                  {canCreateWarehouseItem && (
                    <button
                      type="button"
                      aria-label="Добавить материал"
                      title="Добавить новый материал"
                      onClick={() => setQuickAdd((prev) => (prev === 'material' ? null : 'material'))}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-500/35 bg-emerald-500/10 text-emerald-700 transition hover:bg-emerald-500/15 dark:text-emerald-300"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {materialInputMode === 'search' && matchingMaterials.length > 0 && (
                  <div className="mt-1.5 max-h-28 overflow-y-auto rounded-xl border border-black/[0.08] bg-white p-1 dark:border-white/[0.1] dark:bg-[#15171C]">
                    {matchingMaterials.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setPlannedMaterials((prev) => [...prev, { materialId: m.id, qty: '1' }]);
                          setMaterialQuery('');
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1 text-left text-xs hover:bg-[#0071E3]/10 hover:text-[#0071E3]"
                      >
                        <span className="truncate font-medium">{m.name}</span>
                        <span className="ml-2 shrink-0 text-[11px] text-zinc-400">
                          {formatQty(Math.max(0, m.quantity_milli - (m.reserved_milli || 0)))} {m.unit}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">Инструменты</div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setToolInputMode((prev) => (prev === 'search' ? 'list' : 'search'))}
                    title={toolInputMode === 'search' ? 'Поиск по названию (нажмите для списка)' : 'Выпадающий список (нажмите для поиска)'}
                    aria-label={toolInputMode === 'search' ? 'Открыть список инструментов' : 'Переключить на поиск инструментов'}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/[0.1] bg-white text-zinc-600 transition hover:border-[#0071E3] hover:text-[#0071E3] dark:border-white/[0.12] dark:bg-[#15171C] dark:text-zinc-300"
                  >
                    {toolInputMode === 'search' ? <Search className="h-4 w-4" /> : <List className="h-4 w-4" />}
                  </button>
                  {toolInputMode === 'search' ? (
                    <input
                      type="text"
                      value={toolQuery}
                      onChange={(e) => setToolQuery(e.target.value)}
                      placeholder="Поиск инструмента по названию..."
                      className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white px-3 text-xs outline-none focus:border-[#0071E3] dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                  ) : (
                    <select
                      aria-label="Выбор инструмента из списка"
                      value=""
                      onChange={(e) => {
                        const toolId = e.target.value;
                        if (!toolId) return;
                        setPlannedTools((prev) => [...prev, { toolId, qty: '1' }]);
                      }}
                      className="h-9 min-w-0 flex-1 rounded-xl border border-black/[0.1] bg-white px-3 text-xs outline-none dark:border-white/[0.12] dark:bg-[#15171C]"
                    >
                      <option value="">— Выбрать инструмент —</option>
                      {localTools.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.icon_emoji} {t.name} ({t.available_qty}/{t.total_qty})
                        </option>
                      ))}
                    </select>
                  )}
                  {canCreateWarehouseItem && (
                    <button
                      type="button"
                      aria-label="Добавить инструмент"
                      title="Добавить новый инструмент"
                      onClick={() => setQuickAdd((prev) => (prev === 'tool' ? null : 'tool'))}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-500/35 bg-emerald-500/10 text-emerald-700 transition hover:bg-emerald-500/15 dark:text-emerald-300"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {toolInputMode === 'search' && matchingTools.length > 0 && (
                  <div className="mt-1.5 max-h-28 overflow-y-auto rounded-xl border border-black/[0.08] bg-white p-1 dark:border-white/[0.1] dark:bg-[#15171C]">
                    {matchingTools.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setPlannedTools((prev) => [...prev, { toolId: t.id, qty: '1' }]);
                          setToolQuery('');
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1 text-left text-xs hover:bg-[#0071E3]/10 hover:text-[#0071E3]"
                      >
                        <span className="truncate font-medium">{t.icon_emoji} {t.name}</span>
                        <span className="ml-2 shrink-0 text-[11px] text-zinc-400">
                          {t.available_qty}/{t.total_qty}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {quickAdd === 'material' && (
              <div className="mt-2.5 space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
                <div className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  Добавить новый материал на склад и в заказ
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-4">
                  <input
                    type="text"
                    value={qmName}
                    onChange={(e) => setQmName(e.target.value)}
                    placeholder="Название материала *"
                    className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs sm:col-span-2 dark:border-white/[0.1] dark:bg-[#15171C]"
                  />
                  <input
                    type="text"
                    value={qmUnit}
                    onChange={(e) => setQmUnit(e.target.value)}
                    placeholder="Ед. (шт, м)"
                    className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={qmQty}
                    onChange={(e) => setQmQty(e.target.value)}
                    placeholder="Остаток"
                    className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={qmPriceRub}
                    onChange={(e) => setQmPriceRub(e.target.value)}
                    placeholder="Цена закупки, ₽"
                    className="w-36 rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                  />
                  <button
                    type="button"
                    disabled={quickBusy}
                    onClick={() => void handleQuickCreateMaterial()}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Сохранить и добавить
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickAdd(null)}
                    className="rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1]"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}

            {quickAdd === 'tool' && (
              <div className="mt-2.5 space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
                <div className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  Добавить новый инструмент на склад и в заказ
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                  <input
                    type="text"
                    value={qtName}
                    onChange={(e) => setQtName(e.target.value)}
                    placeholder="Название инструмента *"
                    className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                  />
                  <select
                    value={qtMode}
                    onChange={(e) => setQtMode(e.target.value as 'quantity' | 'individual')}
                    className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                  >
                    <option value="quantity">Количественный</option>
                    <option value="individual">Поштучный (инв. №)</option>
                  </select>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={qtQty}
                    onChange={(e) => setQtQty(e.target.value)}
                    placeholder="Кол-во"
                    className="rounded-lg border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={quickBusy}
                    onClick={() => void handleQuickCreateTool()}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Сохранить и добавить
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickAdd(null)}
                    className="rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1]"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}

            {(plannedMaterials.length > 0 || plannedTools.length > 0) && (
              <div className="mt-2.5 space-y-2">
                {plannedMaterials.map((pm, idx) => (
                  <div key={`pm-${idx}`} className="flex items-center gap-2">
                    <select
                      value={pm.materialId}
                      onChange={(e) => {
                        const next = [...plannedMaterials];
                        next[idx].materialId = e.target.value;
                        setPlannedMaterials(next);
                      }}
                      className="flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                    >
                      {localMaterials.map((m) => (
                        <option key={m.id} value={m.id} disabled={m.id !== pm.materialId && plannedMaterials.some(item => item.materialId === m.id)}>
                          {m.name} (свободно {formatQty(Math.max(0,m.quantity_milli-(m.reserved_milli||0)))} {m.unit})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={pm.qty}
                      onChange={(e) => {
                        const next = [...plannedMaterials];
                        next[idx].qty = e.target.value;
                        setPlannedMaterials(next);
                      }}
                      className="w-24 rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setPlannedMaterials(plannedMaterials.filter((_, i) => i !== idx))
                      }
                      className="text-zinc-400 hover:text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}

                {plannedTools.map((pt, idx) => (
                  <div key={`pt-${idx}`} className="flex items-center gap-2">
                    <select
                      value={pt.toolId}
                      onChange={(e) => {
                        const next = [...plannedTools];
                        next[idx].toolId = e.target.value;
                        setPlannedTools(next);
                      }}
                      className="flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                    >
                      {localTools.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.icon_emoji} {t.name} (свободно {formatQty(Math.max(0,t.available_qty*1000-(t.reserved_milli||0)))})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={pt.qty}
                      onChange={(e) => {
                        const next = [...plannedTools];
                        next[idx].qty = e.target.value;
                        setPlannedTools(next);
                      }}
                      className="w-24 rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                    <button
                      type="button"
                      onClick={() => setPlannedTools(plannedTools.filter((_, i) => i !== idx))}
                      className="text-zinc-400 hover:text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

            </div>
          </details>

          <div className="flex gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-2xl border border-black/[0.08] py-3 text-sm font-semibold text-zinc-600 transition hover:bg-black/[0.03] dark:border-white/[0.1] dark:text-zinc-300"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white transition hover:bg-[#0077ED] disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {saving ? 'Сохраняем...' : 'Создать заказ'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface OrderDetailModalProps {
  order: Order | null;
  user: AuthUser;
  directory: DirectoryUser[];
  companies: Company[];
  contacts: Contact[];
  materials: MaterialItem[];
  tools: ToolItem[];
  availableTags: string[];
  onClose: () => void;
  onOrderUpdated: (order: Order) => void;
  onOrderDeleted?: (orderId: string) => void;
  onWarehouseRefresh: () => void;
  onDiscussOrder: (order: Order) => void;
}

export function OrderDetailModal({
  order,
  user,
  directory,
  companies,
  contacts,
  materials,
  tools,
  availableTags,
  onClose,
  onOrderUpdated,
  onOrderDeleted,
  onWarehouseRefresh,
  onDiscussOrder,
}: OrderDetailModalProps) {
  const [tab, setTab] = useState<'info' | 'warehouse' | 'files'>('info');
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Add visit form
  const [newVisitTitle, setNewVisitTitle] = useState('');
  const [newVisitDate, setNewVisitDate] = useState('');
  const [newVisitAssignees, setNewVisitAssignees] = useState<string[]>([]);

  // Visit report modal state
  const [reportingVisitId, setReportingVisitId] = useState<string | null>(null);
  const [repStart, setRepStart] = useState('09:00');
  const [repEnd, setRepEnd] = useState('18:00');
  const [repWork, setRepWork] = useState('');
  const [repNotes, setRepNotes] = useState('');

  // Warehouse op state
  const [whMode, setWhMode] = useState<'material' | 'tool'>('material');
  const [whOpType, setWhOpType] = useState<'issue' | 'consume' | 'return'>('issue');
  const [whMatId, setWhMatId] = useState(materials[0]?.id || '');
  const [whToolId, setWhToolId] = useState(tools[0]?.id || '');
  const [whToolInstanceId, setWhToolInstanceId] = useState('');
  const [whQty, setWhQty] = useState('1');
  const [whNote, setWhNote] = useState('');
  const [whConfirmReserved, setWhConfirmReserved] = useState(false);
  const [reviewNote, setReviewNote] = useState('');

  // Wage input per assignee key `${visitId}:${userId}`
  const [wageInputs, setWageInputs] = useState<Record<string, string>>({});

  // Full order edit fields
  const [editTitle, setEditTitle] = useState('');
  const [editOrderNumber, setEditOrderNumber] = useState('');
  const [editScheduled, setEditScheduled] = useState('');
  const [editCompanyId, setEditCompanyId] = useState('');
  const [editContactId, setEditContactId] = useState('');
  const [editSiteContactName, setEditSiteContactName] = useState('');
  const [editSiteContactPhone, setEditSiteContactPhone] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editComments, setEditComments] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editAssigneeIds, setEditAssigneeIds] = useState<string[]>([]);
  const [editPlannedTools, setEditPlannedTools] = useState<Array<{toolId:string;qty:string}>>([]);
  const [editPlannedMaterials, setEditPlannedMaterials] = useState<Array<{ materialId: string; qty: string }>>([]);
  const [editPriceRub, setEditPriceRub] = useState('');
  const [editStatus, setEditStatus] = useState('');

  // Money panel (admin): order price, payments, material cost override
  const [moneyEditor, setMoneyEditor] = useState<'price' | 'payment' | 'material' | null>(null);
  const [moneyBusy, setMoneyBusy] = useState(false);
  const [priceRub, setPriceRub] = useState('');
  const [payAmountRub, setPayAmountRub] = useState('');
  const [payType, setPayType] = useState<'advance' | 'partial' | 'full' | 'refund'>('partial');
  const [payDate, setPayDate] = useState('');
  const [payComment, setPayComment] = useState('');
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [paymentsExpanded, setPaymentsExpanded] = useState(false);
  const [matOverrideRub, setMatOverrideRub] = useState('');
  const [matOverrideReason, setMatOverrideReason] = useState('');

  // Inline reopen & delete confirmation (replaces window.prompt/confirm)
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [confirmDeleteOrder, setConfirmDeleteOrder] = useState(false);
  const [confirmDeletePaymentId, setConfirmDeletePaymentId] = useState<string | null>(null);
  const [offlineNotice, setOfflineNotice] = useState('');
  const [uploadItems, setUploadItems] = useState<
    Array<{ id: string; name: string; progress: number; status: 'uploading' | 'done' | 'error'; error?: string }>
  >([]);
  const [failedUploads, setFailedUploads] = useState<
    Array<{ id: string; file: File; kind: 'photo' | 'document'; visitId?: string; error: string }>
  >([]);
  const [previewImage, setPreviewImage] = useState<{ url: string; title: string } | null>(null);

  // Report edit & delete state
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [editRepStart, setEditRepStart] = useState('');
  const [editRepEnd, setEditRepEnd] = useState('');
  const [editRepWork, setEditRepWork] = useState('');
  const [editRepNotes, setEditRepNotes] = useState('');
  const [confirmDeleteReportId, setConfirmDeleteReportId] = useState<string | null>(null);

  useEffect(() => {
    if (order) {
      setEditOpen(false);
      setError('');
      setOfflineNotice('');
      setEditTitle(order.title);
      setEditOrderNumber(order.order_number);
      setEditScheduled(order.scheduled_at ? order.scheduled_at.slice(0, 16) : '');
      setEditCompanyId(order.company_id || '');
      setEditContactId(order.client_contact_id || '');
      setEditSiteContactName(order.site_contact_name || '');
      setEditSiteContactPhone(order.site_contact_phone || '');
      setEditAddress(order.address || '');
      setEditDescription(order.description || '');
      setEditComments(order.comments || '');
      setEditTags(order.tags || []);
      setEditAssigneeIds(order.assignees.map((a) => a.id));
      setEditPlannedTools(order.plannedResources.filter(resource=>resource.item_type==='tool' && resource.tool_id).map(resource=>({toolId:resource.tool_id!,qty:String(resource.planned_qty_milli/1000)})));
      setEditPlannedMaterials(order.plannedResources.filter(resource => resource.item_type === 'material' && resource.material_id).map(resource => ({ materialId: resource.material_id!, qty: String(resource.planned_qty_milli / 1000) })));
      setEditPriceRub(
        order.price_kopecks !== undefined ? String(Math.round(order.price_kopecks / 100)) : ''
      );
      setEditStatus(order.status);
      setMoneyEditor(null);
      setEditingPaymentId(null);
      setPriceRub(order.price_kopecks !== undefined ? String(Math.round(order.price_kopecks / 100)) : '');
      setPayAmountRub('');
      setPayType('partial');
      setPayDate(new Date().toISOString().slice(0, 10));
      setPayComment('');
      setMatOverrideRub(
        order.cost_override_kopecks !== null && order.cost_override_kopecks !== undefined
          ? String(Math.round(order.cost_override_kopecks / 100))
          : ''
      );
      setMatOverrideReason('');
      setReopenOpen(false);
      setReopenReason('');
      setConfirmDeleteOrder(false);
      setEditingReportId(null);
      setConfirmDeleteReportId(null);
    }
  }, [order]);

  useEffect(() => {
    setTab('info');
    setPaymentsExpanded(false);
    setUploadItems([]);
    setFailedUploads([]);
    setPreviewImage(null);
  }, [order?.id]);

  useEffect(() => {
    if (!whMatId && materials[0]) setWhMatId(materials[0].id);
    if (!whToolId && tools[0]) setWhToolId(tools[0].id);
  }, [materials, tools, whMatId, whToolId]);

  useEffect(() => {
    if (!order) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (previewImage) {
        setPreviewImage(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [order, previewImage, onClose]);

  if (!order) return null;

  const isAdmin = user.role === 'admin';
  const isClosedOrder = order.status === 'completed' || order.status === 'cancelled';
  const isClosedLocked = isClosedOrder && !isAdmin;
  const canTakeWarehouse = isAdmin || user.permissions['warehouse.take'];
  const canEditOrder = isAdmin || user.permissions['orders.edit_assigned'];
  const statusMeta = ORDER_STATUS_META[order.status] || ORDER_STATUS_META.new;
  const orderPayments = order.payments || [];
  const orderPriceKopecks = Number(order.price_kopecks || 0);
  const orderPaidKopecks = Number(order.paid_kopecks || 0);
  const orderDebtKopecks = Math.max(0, orderPriceKopecks - orderPaidKopecks);
  const advanceKopecks = orderPayments
    .filter((payment) => payment.payment_type === 'advance')
    .reduce((sum, payment) => sum + Number(payment.amount_kopecks || 0), 0);
  const otherPaymentsKopecks = orderPayments
    .filter((payment) => payment.payment_type !== 'advance')
    .reduce((sum, payment) => sum + Number(payment.amount_kopecks || 0), 0);
  const autoMaterialKopecks = Number(
    order.auto_material_cost_kopecks ?? order.material_cost_kopecks ?? 0
  );
  const hasMaterialOverride =
    order.cost_override_kopecks !== null && order.cost_override_kopecks !== undefined;

  const selectedToolObj = tools.find((t) => t.id === whToolId);
  const editFilteredContacts = editCompanyId
    ? contacts.filter((c) => c.company_id === editCompanyId)
    : contacts;

  const handleSaveOrderEdit = async () => {
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(`/api/orders/${order.id}`, {
        method: 'PATCH',
        body: {
          title: editTitle,
          orderNumber: editOrderNumber,
          scheduledAt: editScheduled || null,
          companyId: editCompanyId || null,
          clientContactId: editContactId || null,
          siteContactName: editSiteContactName,
          siteContactPhone: editSiteContactPhone,
          address: editAddress,
          description: editDescription,
          comments: editComments,
          tags: editTags,
          plannedMaterials: editPlannedMaterials.map(item => ({ materialId: item.materialId, qtyMilli: Math.round(Number(item.qty) * 1000) })),
            plannedTools: editPlannedTools.map(tool=>({toolId:tool.toolId,qty:Number(tool.qty)})),
          ...(isAdmin
            ? {
                status: editStatus,
                priceKopecks: Math.round(Number(editPriceRub || 0) * 100),
                assigneeIds: editAssigneeIds,
              }
            : {}),
        },
        offlineLabel: `Обновление заказа ${order.order_number}`,
      });
      if (res.offlineQueued) {
        setOfflineNotice('Изменения сохранены в офлайн-очередь и отправятся при появлении сети.');
      } else if (res.order) {
        onOrderUpdated(res.order);
        onWarehouseRefresh();
        setEditOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления');
    } finally {
      setBusy(false);
    }
  };

  const reloadOrder = async () => {
    const res = await apiRequest<{ order: Order }>(`/api/orders/${order.id}`);
    onOrderUpdated(res.order);
    return res.order;
  };

  const openPriceEditor = () => {
    setMoneyEditor((prev) => (prev === 'price' ? null : 'price'));
    setError('');
    setPriceRub(
      order.price_kopecks !== undefined ? String(Math.round(order.price_kopecks / 100)) : ''
    );
  };

  const openPaymentEditor = (payment?: OrderPayment) => {
    setMoneyEditor('payment');
    setError('');
    if (payment) {
      setEditingPaymentId(payment.id);
      setPayAmountRub(String(Math.round(Math.abs(payment.amount_kopecks) / 100)));
      setPayType((payment.payment_type || (payment.amount_kopecks < 0 ? 'refund' : 'partial')) as 'advance' | 'partial' | 'full' | 'refund');
      setPayDate((payment.paid_at || '').slice(0, 10));
      setPayComment(payment.comment || '');
      return;
    }
    setEditingPaymentId(null);
    setPayAmountRub('');
    setPayType(Number(order.paid_kopecks || 0) <= 0 ? 'advance' : 'partial');
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayComment('');
  };

  const openMaterialEditor = () => {
    setMoneyEditor((prev) => (prev === 'material' ? null : 'material'));
    setError('');
    setMatOverrideRub(
      order.cost_override_kopecks !== null && order.cost_override_kopecks !== undefined
        ? String(Math.round(order.cost_override_kopecks / 100))
        : ''
    );
    setMatOverrideReason('');
  };

  const handleSavePrice = async () => {
    if (!order) return;
    setMoneyBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const rub = priceRub.trim() === '' ? 0 : Number(priceRub);
      if (!Number.isFinite(rub) || rub < 0) {
        setError('Укажите неотрицательную сумму заказа.');
        return;
      }
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(
        `/api/orders/${order.id}`,
        {
          method: 'PATCH',
          body: { priceKopecks: Math.round(rub * 100) },
          offlineLabel: `Изменение суммы заказа ${order.order_number}`,
        }
      );
      if (res.offlineQueued) {
        setOfflineNotice('Изменение суммы сохранено в офлайн-очередь.');
        setMoneyEditor(null);
      } else if (res.order) {
        onOrderUpdated(res.order);
        setMoneyEditor(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка изменения суммы заказа');
    } finally {
      setMoneyBusy(false);
    }
  };

  const handleSavePayment = async () => {
    if (!order) return;
    setMoneyBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const amount = Math.round(Number(payAmountRub) * 100);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        setError('Укажите сумму оплаты больше нуля.');
        return;
      }
      const body = {
        orderId: order.id,
        amountKopecks: amount,
        paymentType: payType,
        paidAt: payDate || new Date().toISOString().slice(0, 10),
        comment: payComment,
      };
      const res = editingPaymentId
        ? await apiRequest<{ offlineQueued?: boolean }>(`/api/finance/payments/${editingPaymentId}`, {
            method: 'PATCH',
            body,
            offlineLabel: 'Обновление оплаты по заказу',
          })
        : await apiRequest<{ offlineQueued?: boolean }>('/api/finance/payments', {
            method: 'POST',
            body,
            offlineLabel: 'Добавление оплаты по заказу',
          });
      if (res.offlineQueued) {
        setOfflineNotice('Оплата сохранена в офлайн-очередь.');
        setMoneyEditor(null);
      } else {
        await reloadOrder();
        setEditingPaymentId(null);
        setMoneyEditor(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения оплаты');
    } finally {
      setMoneyBusy(false);
    }
  };

  const handleDeletePayment = async (payment: OrderPayment) => {
    if (!order) return;
    setMoneyBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(
        `/api/finance/payments/${payment.id}`,
        { method: 'DELETE', offlineLabel: 'Удаление оплаты по заказу' }
      );
      setConfirmDeletePaymentId(null);
      if (res.offlineQueued) {
        setOfflineNotice('Удаление оплаты сохранено в офлайн-очередь.');
      } else {
        await reloadOrder();
      }
      if (editingPaymentId === payment.id) setEditingPaymentId(null);
      setMoneyEditor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления оплаты');
    } finally {
      setMoneyBusy(false);
    }
  };

  const saveMaterialOverride = async (reset: boolean) => {
    if (!order) return;
    setMoneyBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const raw = matOverrideRub.trim();
      const value = reset || raw === '' ? null : Math.round(Number(raw) * 100);
      if (value !== null && (!Number.isFinite(Number(raw)) || value < 0)) {
        setError('Укажите неотрицательную сумму материалов.');
        return;
      }
      const res = await apiRequest<{ offlineQueued?: boolean }>(
        `/api/finance/orders/${order.id}/cost-override`,
        {
          method: 'POST',
          body: {
            costOverrideKopecks: value,
            reason: reset ? 'Сброс ручной суммы' : matOverrideReason,
          },
          offlineLabel: 'Корректировка себестоимости материалов',
        }
      );
      if (res.offlineQueued) {
        setOfflineNotice('Корректировка сохранена в офлайн-очередь.');
      } else {
        await reloadOrder();
      }
      setMoneyEditor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка корректировки материалов');
    } finally {
      setMoneyBusy(false);
    }
  };

  const handleCancelOrder = async () => {
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(`/api/orders/${order.id}`, {
        method: 'PATCH',
        body: { status: 'cancelled' },
        offlineLabel: `Отмена заказа ${order.order_number}`,
      });
      if (res.offlineQueued) {
        setOfflineNotice('Отмена заказа сохранена в офлайн-очередь.');
      } else if (res.order) {
        onOrderUpdated(res.order);
        onWarehouseRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отмены заказа');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteOrder = async () => {
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/orders/${order.id}`, {
        method: 'DELETE',
        offlineLabel: `Удаление заказа ${order.order_number}`,
      });
      if (res.offlineQueued) {
        setOfflineNotice('Удаление заказа поставлено в офлайн-очередь.');
        setConfirmDeleteOrder(false);
      } else {
        onOrderDeleted?.(order.id);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления заказа');
    } finally {
      setBusy(false);
    }
  };

  const handleReopen = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(`/api/orders/${order.id}/reopen`, {
        method: 'POST',
        body: { reason: reopenReason.trim() },
        offlineLabel: `Возврат заказа ${order.order_number} в работу`,
      });
      setReopenOpen(false);
      setReopenReason('');
      if (res.offlineQueued) {
        setOfflineNotice('Возврат в работу поставлен в офлайн-очередь.');
      } else if (res.order) {
        onOrderUpdated(res.order);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const handleAddVisit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVisitDate) return;
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(`/api/orders/${order.id}/visits`, {
        method: 'POST',
        body: {
          title: newVisitTitle || `Выезд ${order.visits.length + 1}`,
          scheduledAt: newVisitDate,
          assigneeIds:
            newVisitAssignees.length > 0
              ? newVisitAssignees
              : order.assignees.map((a) => a.id),
        },
        offlineLabel: `Новый выезд по ${order.order_number}`,
      });
      setNewVisitTitle('');
      setNewVisitDate('');
      setNewVisitAssignees([]);
      if (res.offlineQueued) {
        setOfflineNotice('Новый выезд сохранён в офлайн-очередь.');
      } else if (res.order) {
        onOrderUpdated(res.order);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления выезда');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitReport = async (e: React.FormEvent, visitId: string, completeVisit: boolean) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(
        `/api/orders/${order.id}/visits/${visitId}/report`,
        {
          method: 'POST',
          body: {
            ...(isAdmin ? { startTime: repStart, endTime: repEnd } : {}),
            workDone: repWork,
            notes: repNotes,
            completeVisit,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          },
          offlineLabel: `Отчёт по выезду ${order.order_number}`,
        }
      );
      setReportingVisitId(null);
      setRepWork('');
      setRepNotes('');
      if (res.offlineQueued) {
        setOfflineNotice('Отчёт сохранён в офлайн-очередь и отправится при появлении сети.');
      } else if (res.order) {
        onOrderUpdated(res.order);
        onWarehouseRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки отчёта');
    } finally {
      setBusy(false);
    }
  };

  const handleEditReportSubmit = async (e: React.FormEvent, visitId: string, reportId: string) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(
        `/api/orders/${order.id}/visits/${visitId}/reports/${reportId}`,
        {
          method: 'PATCH',
          body: {
            ...(isAdmin ? { startTime: editRepStart, endTime: editRepEnd } : {}),
            workDone: editRepWork,
            notes: editRepNotes,
          },
          offlineLabel: `Редактирование отчёта ${order.order_number}`,
        }
      );
      setEditingReportId(null);
      if (res.offlineQueued) {
        setOfflineNotice('Изменения отчёта сохранены в офлайн-очередь.');
      } else if (res.order) {
        onOrderUpdated(res.order);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления отчёта');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteReport = async (visitId: string, reportId: string) => {
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(
        `/api/orders/${order.id}/visits/${visitId}/reports/${reportId}`,
        {
          method: 'DELETE',
          offlineLabel: `Удаление отчёта ${order.order_number}`,
        }
      );
      setConfirmDeleteReportId(null);
      if (res.offlineQueued) {
        setOfflineNotice('Удаление отчёта поставлено в офлайн-очередь.');
      } else if (res.order) {
        onOrderUpdated(res.order);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления отчёта');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(
        `/api/orders/attachments/${attachmentId}`,
        {
          method: 'DELETE',
          offlineLabel: `Удаление файла ${order.order_number}`,
        }
      );
      if (res.offlineQueued) {
        setOfflineNotice('Удаление файла поставлено в офлайн-очередь.');
      } else {
        const fresh = await apiRequest<{ order: Order }>(`/api/orders/${order.id}`);
        onOrderUpdated(fresh.order);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления файла');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignWage = async (visitId: string, userId: string) => {
    const key = `${visitId}:${userId}`;
    const rub = Number(wageInputs[key]);
    if (Number.isNaN(rub) || rub < 0) return;
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const wageRes = await apiRequest<{ offlineQueued?: boolean }>('/api/salaries/visit-wage', {
        method: 'POST',
        body: { visitId, userId, amountKopecks: Math.round(rub * 100) },
        offlineLabel: `Начисление за выезд ${order.order_number}`,
      });
      if (wageRes.offlineQueued) {
        setOfflineNotice('Начисление за выезд сохранено в офлайн-очередь.');
      } else {
        const fresh = await apiRequest<{ order: Order }>(`/api/orders/${order.id}`);
        onOrderUpdated(fresh.order);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка назначения оплаты');
    } finally {
      setBusy(false);
    }
  };

  const handleWarehouseAction = async (e?: React.FormEvent, forceConfirm = false) => {
    e?.preventDefault();
    const material=materials.find(item=>item.id===whMatId), tool=tools.find(item=>item.id===whToolId);
    const resource=order.plannedResources.find(item=>whMode==='material'?item.material_id===whMatId:item.tool_id===whToolId);
    const reservedOther=Math.max(0,(whMode==='material'?material?.reserved_milli:tool?.reserved_milli)||0)-Number(resource?.reserved_remaining_milli||0);
    const available=whMode==='material'?(material?.quantity_milli||0):(tool?.available_qty||0)*1000;
    const confirmReserved=whOpType!=='return' && (reservedOther>available-Number(whQty||1)*1000 || !navigator.onLine);
    if(confirmReserved && !forceConfirm && !whConfirmReserved) {
      setWhConfirmReserved(true);
      return;
    }
    setWhConfirmReserved(false);
    setBusy(true);
    setError('');
    setOfflineNotice('');
    try {
      const res = await apiRequest<{ order?: Order; negativeStockWarning?: boolean; offlineQueued?: boolean }>(
        `/api/orders/${order.id}/resources`,
        {
          method: 'POST',
          body:
            whMode === 'material'
              ? {
                  itemType: 'material',
                  opType: whOpType,
                  materialId: whMatId,
                  qtyMilli: Math.round(Number(whQty) * 1000),
                  note: whNote,
                  confirmReserved,
                }
              : {
                  itemType: 'tool',
                  opType: whOpType === 'consume' ? 'issue' : whOpType,
                  toolId: whToolId,
                  toolInstanceId: whToolInstanceId || undefined,
                  qty: Math.round(Number(whQty || 1)),
                  note: whNote,
                  confirmReserved,
                },
          offlineLabel: `Склад по заказу ${order.order_number}`,
        }
      );
      setWhNote('');
      if (res.offlineQueued) {
        setOfflineNotice('Операция со складом сохранена в офлайн-очередь.');
      } else if (res.order) {
        onOrderUpdated(res.order);
        onWarehouseRefresh();
        if (res.negativeStockWarning) {
          setError('Внимание: остаток материала на складе ушёл в минус. Администратору отправлено уведомление.');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка складской операции');
    } finally {
      setBusy(false);
    }
  };

  const handleQuickResourceOp = async (
    pr: Order['plannedResources'][number],
    actionType: 'issue' | 'return'
  ) => {
    const qtyNum = Math.max(
      0.001,
      Number(pr.reserved_remaining_milli || pr.planned_qty_milli || 1000) / 1000
    );
    if (pr.item_type === 'material' && pr.material_id) {
      const material = materials.find((item) => item.id === pr.material_id);
      const reservedOther =
        Math.max(0, material?.reserved_milli || 0) - Number(pr.reserved_remaining_milli || 0);
      const available = material?.quantity_milli || 0;
      const needsConfirm =
        actionType !== 'return' &&
        (reservedOther > available - qtyNum * 1000 || !navigator.onLine);
      if (needsConfirm) {
        setWhMode('material');
        setWhOpType('issue');
        setWhMatId(pr.material_id);
        setWhQty(String(qtyNum));
        setWhConfirmReserved(true);
        return;
      }
      setBusy(true);
      setError('');
      setOfflineNotice('');
      try {
        const res = await apiRequest<{
          order?: Order;
          negativeStockWarning?: boolean;
          offlineQueued?: boolean;
        }>(`/api/orders/${order.id}/resources`, {
          method: 'POST',
          body: {
            itemType: 'material',
            opType: actionType,
            materialId: pr.material_id,
            qtyMilli: Math.round(qtyNum * 1000),
            note: '',
            confirmReserved: false,
          },
          offlineLabel: `Склад по заказу ${order.order_number}`,
        });
        if (res.offlineQueued) {
          setOfflineNotice('Операция со складом сохранена в офлайн-очередь.');
        } else if (res.order) {
          onOrderUpdated(res.order);
          onWarehouseRefresh();
          if (res.negativeStockWarning) {
            setError(
              'Внимание: остаток материала на складе ушёл в минус. Администратору отправлено уведомление.'
            );
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка складской операции');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (pr.item_type === 'tool' && pr.tool_id) {
      const tool = tools.find((item) => item.id === pr.tool_id);
      const intQty = Math.max(1, Math.round(qtyNum));
      const reservedOther =
        Math.max(0, tool?.reserved_milli || 0) - Number(pr.reserved_remaining_milli || 0);
      const available = (tool?.available_qty || 0) * 1000;
      const needsConfirm =
        actionType !== 'return' &&
        (reservedOther > available - intQty * 1000 || !navigator.onLine);
      if (needsConfirm) {
        setWhMode('tool');
        setWhOpType('issue');
        setWhToolId(pr.tool_id);
        setWhToolInstanceId('');
        setWhQty(String(intQty));
        setWhConfirmReserved(true);
        return;
      }
      const instanceId =
        tool?.tracking_mode === 'individual'
          ? actionType === 'issue'
            ? tool.instances.find((i) => i.status === 'available')?.id
            : tool.instances.find((i) => i.status === 'issued' && i.holder_user_id === user.id)
                ?.id || tool.instances.find((i) => i.status === 'issued')?.id
          : undefined;
      if (tool?.tracking_mode === 'individual' && !instanceId) {
        setWhMode('tool');
        setWhOpType(actionType);
        setWhToolId(pr.tool_id);
        setWhToolInstanceId('');
        setError('Выберите конкретный экземпляр инструмента в форме ниже.');
        return;
      }
      setBusy(true);
      setError('');
      setOfflineNotice('');
      try {
        const res = await apiRequest<{ order?: Order; offlineQueued?: boolean }>(
          `/api/orders/${order.id}/resources`,
          {
            method: 'POST',
            body: {
              itemType: 'tool',
              opType: actionType,
              toolId: pr.tool_id,
              toolInstanceId: instanceId,
              qty: intQty,
              note: '',
              confirmReserved: false,
            },
            offlineLabel: `Инструмент по заказу ${order.order_number}`,
          }
        );
        if (res.offlineQueued) {
          setOfflineNotice('Операция со складом сохранена в офлайн-очередь.');
        } else if (res.order) {
          onOrderUpdated(res.order);
          onWarehouseRefresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка складской операции');
      } finally {
        setBusy(false);
      }
    }
  };

  const reviewCancellation = async (issueKey:'payments'|'accruals') => {
    if(!reviewNote.trim()){setError('Опишите, как решён вопрос.');return;}
    setBusy(true);setError('');
    try {
      const result=await apiRequest<{order:Order}>(`/api/orders/${order.id}/cancellation-review`,{method:'POST',body:{issueKey,note:reviewNote.trim()},skipOfflineQueue:true});
      onOrderUpdated(result.order);setReviewNote('');
    } catch(err) {setError(err instanceof Error?err.message:'Не удалось сохранить отметку');}
    finally {setBusy(false);}
  };

  const runUploadBatch = async (
    batch: Array<{ id: string; file: File; kind: 'photo' | 'document'; visitId?: string }>
  ) => {
    if (!batch.length) return;
    setBusy(true);
    setError('');
    setOfflineNotice('');

    setUploadItems((prev) => {
      const next = prev.filter((item) => item.status === 'error');
      const incomingIds = new Set(batch.map((b) => b.id));
      return [
        ...next.filter((item) => !incomingIds.has(item.id)),
        ...batch.map((b) => ({ id: b.id, name: b.file.name, progress: 0, status: 'uploading' as const })),
      ];
    });

    const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    const nextFailed: Array<{ id: string; file: File; kind: 'photo' | 'document'; visitId?: string; error: string }> = [];
    const succeededIds = new Set<string>();

    try {
      for (const item of batch) {
        try {
          const fd = new FormData();
          fd.append('file', item.file);
          fd.append('kind', item.kind);
          if (item.visitId) fd.append('visitId', item.visitId);

          await uploadWithRetry({
            url: `/api/orders/${order.id}/attachments`,
            formData: fd,
            attempts: 3,
            onProgress: (progress) => {
              setUploadItems((prev) =>
                prev.map((row) => (row.id === item.id ? { ...row, progress, status: 'uploading' } : row))
              );
            },
          });

          succeededIds.add(item.id);
          setUploadItems((prev) =>
            prev.map((row) => (row.id === item.id ? { ...row, progress: 100, status: 'done', error: undefined } : row))
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Ошибка загрузки';
          nextFailed.push({ ...item, error: message });
          setUploadItems((prev) =>
            prev.map((row) => (row.id === item.id ? { ...row, status: 'error', error: message } : row))
          );
        }
      }

      setFailedUploads((prev) => {
        const remainingOld = prev.filter((f) => !succeededIds.has(f.id) && !nextFailed.some((nf) => nf.id === f.id));
        return [...remainingOld, ...nextFailed];
      });

      const fresh = await apiRequest<{ order: Order }>(`/api/orders/${order.id}`, { useCache: false });
      onOrderUpdated(fresh.order);
      if (nextFailed.length) {
        setError(`Не удалось загрузить: ${nextFailed.map((f) => f.file.name).join(', ')}. Нажмите «Повторить неудачные».`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки файла');
    } finally {
      await wakeLock?.release().catch(() => {});
      setBusy(false);
    }
  };

  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    kind: 'photo' | 'document',
    visitId?: string
  ) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    await runUploadBatch(
      files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        kind,
        visitId,
      }))
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-xs sm:items-center sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-black/[0.08] bg-white shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4 sm:px-6 dark:border-white/[0.08]">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-bold text-zinc-500 dark:text-zinc-400">
                {order.order_number}
              </span>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span className={`inline-flex items-center gap-1.5 font-semibold ${statusMeta.textClass}`}>
                <span className={`h-2 w-2 rounded-full ${statusMeta.dotClass}`} />
                {statusMeta.label}
              </span>
            </div>
            <h2 className="mt-1 font-display text-lg font-bold tracking-tight sm:text-xl">
              {order.title}
            </h2>
            {order.tags.length > 0 && (
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {order.tags.join(' · ')}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onDiscussOrder(order)}
              className="inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-black/[0.08] bg-[#F5F5F7] px-3 text-xs font-semibold text-[#0071E3] hover:bg-black/[0.06] dark:border-white/[0.1] dark:bg-[#0B0C10] dark:text-[#71b5ff]"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Перейти в чат</span>
            </button>
            {canEditOrder && !isClosedLocked && (
              <button
                type="button"
                onClick={() => {
                  setTab('info');
                  setEditOpen((prev) => !prev);
                }}
                className={`inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition ${
                  editOpen
                    ? 'border-[#0071E3] bg-[#0071E3] text-white dark:border-[#2997FF] dark:bg-[#2997FF] dark:text-[#0B0C10]'
                    : 'border-black/[0.08] bg-[#F5F5F7] text-[#0071E3] hover:bg-black/[0.06] dark:border-white/[0.1] dark:bg-[#0B0C10] dark:text-[#71b5ff]'
                }`}
              >
                <Pencil className="h-3.5 w-3.5" />
                <span>Редактировать</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть карточку заказа"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-black/[0.05] text-zinc-500 hover:text-zinc-800 dark:bg-white/[0.06] dark:text-zinc-300"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Section Tabs */}
        {isAdmin && order.cancellationIssues && <div className="space-y-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 text-sm">
          <div className="font-semibold">После отмены проверьте незакрытые вопросы</div>
          {order.cancellationIssues.materials.map(item=><p key={item.id}>Материал на заказе: {item.name} — {formatQty(item.unconsumedIssuedMilli)} {item.unit}</p>)}
          {order.cancellationIssues.tools.map(item=><p key={item.id}>Инструмент на заказе: {item.name} — {formatQty(item.qty_milli)} шт</p>)}
          {(['payments','accruals'] as const).map(key=>{
            const amount=key==='payments'?order.cancellationIssues!.paymentsKopecks:order.cancellationIssues!.accrualsKopecks;
            const review=order.cancellationIssues!.reviews.find(item=>item.issue_key===key);
            if(!amount) return null;
            return <div key={key}><p>{key==='payments'?'Получено от клиента':'Начислено сотрудникам'}: {formatRub(amount)}. {review?`Проверено: ${review.note}`:'Требует проверки.'}</p>{!review && <button type="button" disabled={busy} className="text-blue-600 underline" onClick={()=>void reviewCancellation(key)}>Отметить решённым</button>}</div>;
          })}
          {((order.cancellationIssues.paymentsKopecks && !order.cancellationIssues.reviews.some(r=>r.issue_key==='payments')) || (order.cancellationIssues.accrualsKopecks && !order.cancellationIssues.reviews.some(r=>r.issue_key==='accruals'))) ? <input value={reviewNote} onChange={e=>setReviewNote(e.target.value)} placeholder="Как решили вопрос" className="w-full rounded-xl border border-zinc-400 bg-white p-2 dark:bg-[#0B0C10]" /> : null}
          <p className="text-xs">Отметка фиксирует решение, но не выполняет выплату или возврат автоматически.</p>
        </div>}
        <div className="flex gap-1 overflow-x-auto border-b border-black/[0.06] px-4 py-2 sm:px-6 dark:border-white/[0.08]">
          {[
            { id: 'info', label: 'Основное', icon: ClipboardList },
            { id: 'warehouse', label: 'Материалы и инструменты', icon: Package },
            { id: 'files', label: `Файлы (${order.attachments.length})`, icon: ImageIcon },
          ].map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id as any)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                  active
                    ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                    : 'text-zinc-600 hover:bg-black/[0.04] dark:text-zinc-400 dark:hover:bg-white/[0.06]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6">
          {error && (
            <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          {offlineNotice && (
            <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
              {offlineNotice}
            </div>
          )}
          {uploadItems.length > 0 && (
            <div className="mb-4 space-y-2 rounded-2xl border border-black/[0.08] bg-[#F5F5F7] p-3.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">Загрузка файлов</span>
                <div className="flex items-center gap-2">
                  {failedUploads.length > 0 && !busy && (
                    <button
                      type="button"
                      onClick={() => void runUploadBatch(failedUploads)}
                      className="rounded-lg bg-[#0071E3] px-2.5 py-1 text-[11px] font-semibold text-white"
                    >
                      Повторить неудачные ({failedUploads.length})
                    </button>
                  )}
                  {!busy && (
                    <button
                      type="button"
                      onClick={() => {
                        setUploadItems([]);
                        setFailedUploads([]);
                      }}
                      className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                    >
                      Скрыть
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                {uploadItems.map((item) => (
                  <div key={item.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{item.name}</span>
                      <span
                        className={`shrink-0 tabular-nums ${
                          item.status === 'error'
                            ? 'text-red-600 dark:text-red-400'
                            : item.status === 'done'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-zinc-500'
                        }`}
                      >
                        {item.status === 'error'
                          ? item.error || 'Ошибка'
                          : item.status === 'done'
                            ? 'Готово'
                            : `${item.progress}%`}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                      <div
                        className={`h-full transition-all ${
                          item.status === 'error'
                            ? 'bg-red-500'
                            : item.status === 'done'
                              ? 'bg-emerald-500'
                              : 'bg-[#0071E3]'
                        }`}
                        style={{ width: `${item.status === 'error' ? 100 : item.progress}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'info' && (
            <div className="space-y-4">
              {isClosedLocked && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                  Заказ закрыт. Редактирование, отчёты, складские операции и загрузка документов заблокированы — разрешена только загрузка фотографий.
                </div>
              )}
              <div className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
                <Calendar className="h-4 w-4 text-[#0071E3] dark:text-[#71b5ff]" />
                <span>{order.scheduled_at ? formatDateTimeRu(order.scheduled_at) : 'Дата не запланирована'}</span>
              </div>
              {isAdmin && (
                <div className="space-y-3">
                  {(() => {
                    const orderOverpaidKopecks = Math.max(
                      0,
                      order.overpaid_kopecks ?? orderPaidKopecks - orderPriceKopecks
                    );
                    const orderSalaryKopecks = Number(order.salary_cost_kopecks || 0);
                    const orderProfitKopecks =
                      order.profit_kopecks ??
                      orderPriceKopecks - Number(order.material_cost_kopecks || 0) - orderSalaryKopecks;
                    const refundedKopecks = orderPayments
                      .filter((p) => Number(p.amount_kopecks || 0) < 0 || p.payment_type === 'refund')
                      .reduce((sum, p) => sum + Math.abs(Number(p.amount_kopecks || 0)), 0);
                    return (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7] p-3 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-[11px] text-zinc-500">Сумма заказа</div>
                            <button
                              type="button"
                              onClick={openPriceEditor}
                              aria-label="Изменить сумму заказа"
                              title="Изменить сумму заказа"
                              className="rounded-lg p-1 text-zinc-400 hover:bg-black/[0.05] hover:text-[#0071E3] dark:hover:bg-white/[0.08]"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="mt-0.5 text-base font-bold tabular-nums">
                            {formatRub(order.price_kopecks)}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            Долг клиента: {formatRub(orderDebtKopecks)}
                          </div>
                          {orderOverpaidKopecks > 0 && (
                            <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                              Переплата: +{formatRub(orderOverpaidKopecks)}
                            </div>
                          )}
                        </div>
                        <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7] p-3 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-[11px] text-zinc-500">Оплачено</div>
                            <button
                              type="button"
                              onClick={() => openPaymentEditor()}
                              aria-label="Добавить оплату"
                              title="Добавить или изменить оплату"
                              className="rounded-lg p-1 text-zinc-400 hover:bg-black/[0.05] hover:text-[#0071E3] dark:hover:bg-white/[0.08]"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="mt-0.5 text-base font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                            {formatRub(order.paid_kopecks)}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            Аванс {formatRub(advanceKopecks)} · Доплаты {formatRub(otherPaymentsKopecks)}
                            {refundedKopecks > 0 ? ` · Возврат −${formatRub(refundedKopecks)}` : ''}
                          </div>
                        </div>
                        <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7] p-3 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-[11px] text-zinc-500">Материалы (списано)</div>
                            <button
                              type="button"
                              onClick={openMaterialEditor}
                              aria-label="Изменить себестоимость материалов"
                              title="Изменить себестоимость материалов"
                              className="rounded-lg p-1 text-zinc-400 hover:bg-black/[0.05] hover:text-[#0071E3] dark:hover:bg-white/[0.08]"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="mt-0.5 text-base font-bold tabular-nums">
                            {formatRub(order.material_cost_kopecks)}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            {hasMaterialOverride
                              ? `Ручная сумма · по списаниям ${formatRub(autoMaterialKopecks)}`
                              : 'Средневзвешенный расчёт'}
                          </div>
                        </div>
                        <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7] p-3 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                          <div className="text-[11px] text-zinc-500">Прибыль по заказу</div>
                          <div
                            className={`mt-0.5 text-base font-bold tabular-nums ${
                              orderProfitKopecks >= 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400'
                            }`}
                          >
                            {orderProfitKopecks < 0 ? '−' : ''}
                            {formatRub(Math.abs(orderProfitKopecks))}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            Зарплата: {formatRub(orderSalaryKopecks)}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {moneyEditor === 'price' && (
                    <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
                      <div className="mb-3 text-xs font-semibold">Сумма заказа</div>
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="min-w-40 flex-1 text-[11px] text-zinc-500">
                          Сумма, ₽
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            autoFocus
                            value={priceRub}
                            onChange={(e) => setPriceRub(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm tabular-nums text-zinc-900 dark:border-white/[0.1] dark:bg-[#0B0C10] dark:text-zinc-100"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => void handleSavePrice()}
                          disabled={moneyBusy}
                          className="rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Сохранить
                        </button>
                        <button
                          type="button"
                          onClick={() => setMoneyEditor(null)}
                          className="rounded-xl border border-black/[0.1] px-4 py-2 text-xs font-semibold dark:border-white/[0.12]"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  )}

                  {moneyEditor === 'payment' && (
                    <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold">
                          {editingPaymentId
                            ? 'Изменить операцию'
                            : payType === 'refund'
                              ? 'Возврат клиенту'
                              : 'Добавить оплату'}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setMoneyEditor(null);
                            setEditingPaymentId(null);
                          }}
                          className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                          aria-label="Закрыть форму оплаты"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <input
                          type="number"
                          min="1"
                          step="0.01"
                          autoFocus
                          value={payAmountRub}
                          onChange={(e) => setPayAmountRub(e.target.value)}
                          placeholder="Сумма, ₽"
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                        />
                        <select
                          value={payType}
                          onChange={(e) => setPayType(e.target.value as 'advance' | 'partial' | 'full' | 'refund')}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm dark:border-white/[0.1] dark:bg-[#0B0C10]"
                        >
                          <option value="advance">Аванс</option>
                          <option value="partial">Доплата</option>
                          <option value="full">Полный расчёт</option>
                          <option value="refund">Возврат клиенту</option>
                        </select>
                        <input
                          type="date"
                          value={payDate}
                          onChange={(e) => setPayDate(e.target.value)}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm dark:border-white/[0.1] dark:bg-[#0B0C10]"
                        />
                        <input
                          type="text"
                          maxLength={300}
                          value={payComment}
                          onChange={(e) => setPayComment(e.target.value)}
                          placeholder="Комментарий"
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm sm:col-span-2 dark:border-white/[0.1] dark:bg-[#0B0C10]"
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSavePayment()}
                          disabled={moneyBusy}
                          className={`rounded-xl px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 ${
                            payType === 'refund' ? 'bg-amber-600' : 'bg-[#0071E3]'
                          }`}
                        >
                          {editingPaymentId
                            ? 'Сохранить изменения'
                            : payType === 'refund'
                              ? 'Провести возврат'
                              : 'Добавить оплату'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMoneyEditor(null);
                            setEditingPaymentId(null);
                          }}
                          className="rounded-xl border border-black/[0.1] px-4 py-2 text-xs font-semibold dark:border-white/[0.12]"
                        >
                          Отмена
                        </button>
                        <span className="text-[11px] text-zinc-500">
                          {payType === 'refund'
                            ? 'Возврат уменьшает кассу и сумму оплат по заказу.'
                            : 'Платёж привязывается к заказу и попадает в финансы.'}
                        </span>
                      </div>
                    </div>
                  )}

                  {moneyEditor === 'material' && (
                    <div className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#15171C]">
                      <div className="text-xs font-semibold">Себестоимость материалов</div>
                      <p className="mt-1 text-[11px] text-zinc-500">
                        По списаниям со склада: {formatRub(autoMaterialKopecks)}. Ручная сумма заменяет
                        расчёт в финансах по этому заказу. Пустое поле возвращает расчёт по списаниям.
                      </p>
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          autoFocus
                          value={matOverrideRub}
                          onChange={(e) => setMatOverrideRub(e.target.value)}
                          placeholder="Сумма, ₽"
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm tabular-nums dark:border-white/[0.1] dark:bg-[#0B0C10]"
                        />
                        <input
                          type="text"
                          maxLength={300}
                          value={matOverrideReason}
                          onChange={(e) => setMatOverrideReason(e.target.value)}
                          placeholder="Причина (для истории)"
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm dark:border-white/[0.1] dark:bg-[#0B0C10]"
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void saveMaterialOverride(false)}
                          disabled={moneyBusy}
                          className="rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Сохранить
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveMaterialOverride(true)}
                          disabled={moneyBusy || !hasMaterialOverride}
                          className="rounded-xl border border-black/[0.1] px-4 py-2 text-xs font-semibold disabled:opacity-40 dark:border-white/[0.12]"
                        >
                          Вернуть расчёт
                        </button>
                        <button
                          type="button"
                          onClick={() => setMoneyEditor(null)}
                          className="rounded-xl border border-black/[0.1] px-4 py-2 text-xs font-semibold dark:border-white/[0.12]"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.08]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold">Оплаты по заказу</div>
                        <div className="text-[11px] text-zinc-500">
                          Аванс {formatRub(advanceKopecks)} · Доплаты {formatRub(otherPaymentsKopecks)} ·
                          Осталось {formatRub(orderDebtKopecks)}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {orderPayments.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setPaymentsExpanded((v) => !v)}
                            className="inline-flex items-center gap-1 rounded-xl border border-black/[0.1] px-3 py-1.5 text-xs font-semibold text-zinc-600 hover:bg-black/[0.03] dark:border-white/[0.12] dark:text-zinc-300"
                          >
                            <span>История оплат ({orderPayments.length})</span>
                            <ChevronDown
                              className={`h-3.5 w-3.5 transition-transform ${
                                paymentsExpanded ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openPaymentEditor()}
                          className="inline-flex items-center gap-1 rounded-xl border border-black/[0.1] px-3 py-1.5 text-xs font-semibold text-[#0071E3] dark:border-white/[0.12] dark:text-[#71b5ff]"
                        >
                          <Plus className="h-3.5 w-3.5" /> Добавить
                        </button>
                      </div>
                    </div>
                    {orderPayments.length === 0 ? (
                      <div className="mt-3 rounded-xl border border-dashed border-black/[0.1] p-3 text-xs text-zinc-400 dark:border-white/[0.1]">
                        Оплат пока нет. Добавьте аванс или оплату — они появятся в финансах.
                      </div>
                    ) : paymentsExpanded ? (
                      <div className="mt-3 space-y-1.5">
                        {orderPayments.map((payment) => {
                          const isRefund = payment.payment_type === 'refund' || Number(payment.amount_kopecks || 0) < 0;
                          return (
                          <div
                            key={payment.id}
                            className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] px-3 py-2 dark:border-white/[0.08]"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                <span
                                  className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                                    isRefund
                                      ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                                      : payment.payment_type === 'advance'
                                        ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
                                        : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                  }`}
                                >
                                  {PAYMENT_TYPE_LABELS[payment.payment_type] || payment.payment_type}
                                </span>
                                <span
                                  className={`font-bold tabular-nums ${
                                    isRefund
                                      ? 'text-amber-700 dark:text-amber-300'
                                      : 'text-emerald-600 dark:text-emerald-400'
                                  }`}
                                >
                                  {isRefund ? '−' : ''}
                                  {formatRub(Math.abs(payment.amount_kopecks))}
                                </span>
                              </div>
                              <div className="truncate text-[11px] text-zinc-500">
                                {formatDateRu(payment.paid_at)}
                                {payment.comment ? ` · ${payment.comment}` : ''}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openPaymentEditor(payment)}
                                aria-label="Изменить оплату"
                                title="Изменить оплату"
                                className="rounded-lg p-1.5 text-zinc-400 hover:bg-black/[0.05] hover:text-[#0071E3] dark:hover:bg-white/[0.08]"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              {confirmDeletePaymentId !== payment.id ? (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeletePaymentId(payment.id)}
                                  aria-label="Удалить оплату"
                                  title="Удалить оплату"
                                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-500/10 hover:text-red-600"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              ) : (
                                <div className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px]">
                                  <button
                                    type="button"
                                    disabled={moneyBusy}
                                    onClick={() => void handleDeletePayment(payment)}
                                    className="font-semibold text-red-600 dark:text-red-400"
                                  >
                                    Удалить
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeletePaymentId(null)}
                                    className="text-zinc-500"
                                  >
                                    Отмена
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.08]">
                  <div className="text-xs font-semibold text-zinc-500">Клиент и объект</div>
                  <div className="mt-2 space-y-1.5 text-sm">
                    {order.company && <div className="font-semibold">{order.company.name}</div>}
                    {order.contact && (
                      <div className="flex flex-wrap items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                        <span>{order.contact.full_name}</span>
                        {order.contact.phone && (
                          getTelHref(order.contact.phone) ? (
                            <a
                              href={getTelHref(order.contact.phone)}
                              className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                            >
                              <Phone className="h-3.5 w-3.5" />
                              <span>{order.contact.phone}</span>
                            </a>
                          ) : (
                            <span>· {order.contact.phone}</span>
                          )
                        )}
                      </div>
                    )}
                    {order.address && (
                      <div className="flex flex-wrap items-start gap-2 text-zinc-600 dark:text-zinc-300">
                        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#0071E3]" />
                        <span className="flex-1">{order.address}</span>
                        {getMapHref(order.address) && (
                          <a
                            href={getMapHref(order.address)}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 rounded-lg bg-[#0071E3]/10 px-2 py-0.5 text-xs font-semibold text-[#0071E3] hover:bg-[#0071E3]/15 dark:text-[#71b5ff]"
                          >
                            На карте
                          </a>
                        )}
                      </div>
                    )}
                    {(order.site_contact_name || order.site_contact_phone) && (
                      <div className="flex flex-wrap items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                        <Phone className="h-4 w-4 shrink-0 text-emerald-500" />
                        {order.site_contact_name && <span>{order.site_contact_name}</span>}
                        {order.site_contact_phone && (
                          getTelHref(order.site_contact_phone) ? (
                            <a
                              href={getTelHref(order.site_contact_phone)}
                              className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                            >
                              {order.site_contact_phone}
                            </a>
                          ) : (
                            <span>{order.site_contact_phone}</span>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.08]">
                  <div className="text-xs font-semibold text-zinc-500">Исполнители</div>
                  <div className="mt-2 space-y-1.5 text-sm">
                    {order.assignees.length === 0 ? (
                      <div className="text-zinc-400">Пока не назначены</div>
                    ) : (
                      order.assignees.map((a) => (
                        <div key={a.id} className="flex items-center justify-between">
                          <span className="font-medium">{a.full_name}</span>
                          <span className="text-xs text-zinc-400">{a.position}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {order.description && (
                <div className="rounded-2xl border border-black/[0.06] p-4 text-sm dark:border-white/[0.08]">
                  <div className="mb-1 text-xs font-semibold text-zinc-500">Описание работ</div>
                  <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">
                    {order.description}
                  </p>
                </div>
              )}
              {canEditOrder && !isClosedLocked && editOpen && (
                <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7]/70 p-4 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                  <div className="mb-3 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Редактирование заказа
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-[11px] text-zinc-500" htmlFor="edit-order-number">Номер заказа</label>
                      <input id="edit-order-number" type="text" maxLength={40} value={editOrderNumber} onChange={e => setEditOrderNumber(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]" />
                    </div>
                    <div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">Название заказа</label>
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">Компания</label>
                        <select
                          value={editCompanyId}
                          onChange={(e) => {
                            setEditCompanyId(e.target.value);
                            setEditContactId('');
                          }}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        >
                          <option value="">— Не выбрана —</option>
                          {companies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">Контакт клиента</label>
                        <select
                          value={editContactId}
                          onChange={(e) => setEditContactId(e.target.value)}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        >
                          <option value="">— Не выбран —</option>
                          {editFilteredContacts.map((ct) => (
                            <option key={ct.id} value={ct.id}>
                              {ct.full_name} {ct.phone ? `(${ct.phone})` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div className="sm:col-span-1">
                        <label className="mb-1 block text-[11px] text-zinc-500">Адрес</label>
                        <input
                          type="text"
                          value={editAddress}
                          onChange={(e) => setEditAddress(e.target.value)}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">Контакт на объекте</label>
                        <input
                          type="text"
                          value={editSiteContactName}
                          onChange={(e) => setEditSiteContactName(e.target.value)}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">Телефон на объекте</label>
                        <input
                          type="tel"
                          value={editSiteContactPhone}
                          onChange={(e) => setEditSiteContactPhone(e.target.value)}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] text-zinc-500">Описание работ</label>
                      <textarea
                        rows={2}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] text-zinc-500">Комментарии</label>
                      <input
                        type="text"
                        value={editComments}
                        onChange={(e) => setEditComments(e.target.value)}
                        className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                      />
                    </div>

                    {availableTags.length > 0 && (
                      <div>
                        <div className="mb-1 text-[11px] text-zinc-500">Теги</div>
                        <div className="flex flex-wrap gap-1.5">
                          {availableTags.map((tag) => {
                            const active = editTags.includes(tag);
                            return (
                              <button
                                key={tag}
                                type="button"
                                onClick={() =>
                                  setEditTags((prev) =>
                                    prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                                  )
                                }
                                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
                                  active
                                    ? 'bg-[#0071E3] text-white dark:bg-[#2997FF] dark:text-[#0B0C10]'
                                    : 'bg-white text-zinc-600 dark:bg-[#15171C] dark:text-zinc-300'
                                }`}
                              >
                                {tag}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <label className="mb-1 block text-[11px] text-zinc-500">Дата в календаре</label>
                        <input
                          type="datetime-local"
                          value={editScheduled}
                          onChange={(e) => setEditScheduled(e.target.value)}
                          className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                        />
                      </div>
                      {isAdmin && (
                        <>
                          <div>
                            <label className="mb-1 block text-[11px] text-zinc-500">Статус</label>
                            <select
                              value={editStatus}
                              onChange={(e) => setEditStatus(e.target.value)}
                              className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                            >
                              <option value="new">Новый</option>
                              <option value="in_progress">В работе</option>
                              <option value="completed">Завершён</option>
                              <option value="cancelled">Отменён</option>
                            </select>
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] text-zinc-500">Цена, ₽</label>
                            <input
                              type="number"
                              value={editPriceRub}
                              onChange={(e) => setEditPriceRub(e.target.value)}
                              className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-xs font-semibold">
                        <span>Запланированные материалы</span>
                        <button type="button" disabled={!materials.some(m => !editPlannedMaterials.some(p => p.materialId === m.id))} onClick={() => setEditPlannedMaterials(previous => [...previous, { materialId: materials.find(m => !previous.some(p => p.materialId === m.id))!.id, qty: '1' }])}>Добавить</button>
                      </div>
                      {editPlannedMaterials.map((planned, index) => (
                        <div key={index} className="flex flex-wrap gap-2">
                          <select aria-label="Материал" value={planned.materialId} onChange={event => setEditPlannedMaterials(previous => previous.map((item, i) => i === index ? { ...item, materialId: event.target.value } : item))} className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white p-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]">
                            {!materials.some(material => material.id === planned.materialId) && <option value={planned.materialId}>Материал недоступен</option>}
                            {materials.map(material => <option key={material.id} value={material.id} disabled={material.id !== planned.materialId && editPlannedMaterials.some(item => item.materialId === material.id)}>{material.name} ({material.unit})</option>)}
                          </select>
                          <input aria-label="Количество материала" type="number" min="0.001" step="0.001" value={planned.qty} onChange={event => setEditPlannedMaterials(previous => previous.map((item, i) => i === index ? { ...item, qty: event.target.value } : item))} className="w-24 rounded-xl border border-black/[0.08] bg-white p-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]" />
                          <button type="button" onClick={() => setEditPlannedMaterials(previous => previous.filter((_, i) => i !== index))} className="text-xs text-red-600">Убрать</button>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs font-semibold">
                        <span>Запланированные инструменты</span>
                        <button type="button" disabled={!tools.length} onClick={()=>setEditPlannedTools(previous=>[...previous,{toolId:tools[0]?.id||'',qty:'1'}])}>Добавить</button>
                      </div>
                      {editPlannedTools.map((planned,index)=>(
                        <div key={index} className="flex flex-wrap gap-2">
                          <select aria-label="Инструмент" value={planned.toolId} onChange={event=>setEditPlannedTools(previous=>previous.map((item,i)=>i===index?{...item,toolId:event.target.value}:item))} className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white p-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]">
                            {!tools.some(tool=>tool.id===planned.toolId) && <option value={planned.toolId}>Инструмент недоступен</option>}
                            {tools.map(tool=><option key={tool.id} value={tool.id}>{tool.name}</option>)}
                          </select>
                          <input aria-label="Количество" type="number" min="1" step="1" value={planned.qty} onChange={event=>setEditPlannedTools(previous=>previous.map((item,i)=>i===index?{...item,qty:event.target.value}:item))} className="w-20 rounded-xl border border-black/[0.08] bg-white p-2 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]" />
                          <button type="button" onClick={()=>setEditPlannedTools(previous=>previous.filter((_,i)=>i!==index))} className="text-xs text-red-600">Убрать</button>
                        </div>
                      ))}
                    </div>
                    {isAdmin && directory.length > 0 && (
                      <div>
                        <div className="mb-1 text-[11px] text-zinc-500">Назначенные исполнители</div>
                        <div className="flex flex-wrap gap-1.5">
                          {directory.map((emp) => {
                            const active = editAssigneeIds.includes(emp.id);
                            return (
                              <button
                                key={emp.id}
                                type="button"
                                onClick={() =>
                                  setEditAssigneeIds((prev) =>
                                    prev.includes(emp.id) ? prev.filter((id) => id !== emp.id) : [...prev, emp.id]
                                  )
                                }
                                className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                                  active
                                    ? 'border-[#0071E3] bg-[#0071E3]/10 text-[#0071E3] dark:border-[#2997FF] dark:text-[#2997FF]'
                                    : 'border-black/[0.08] bg-white text-zinc-600 dark:border-white/[0.1] dark:bg-[#15171C] dark:text-zinc-300'
                                }`}
                              >
                                {emp.fullName}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSaveOrderEdit()}
                      className="rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
                    >
                      Сохранить изменения
                    </button>
                    {isAdmin && order.status === 'completed' && !reopenOpen && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setReopenOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Вернуть заказ в работу</span>
                      </button>
                    )}
                    {isAdmin && order.status !== 'cancelled' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleCancelOrder()}
                        className="rounded-xl border border-black/[0.1] px-3.5 py-2 text-xs font-semibold text-zinc-600 hover:bg-black/[0.04] dark:border-white/[0.1] dark:text-zinc-300"
                      >
                        Отменить заказ
                      </button>
                    )}
                    {isAdmin && !confirmDeleteOrder && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteOrder(true)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-2 text-xs font-semibold text-red-600 hover:bg-red-500/20 dark:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Удалить заказ</span>
                      </button>
                    )}
                  </div>

                  {isAdmin && confirmDeleteOrder && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs">
                      <span className="font-semibold text-red-700 dark:text-red-300">
                        Удалить заказ {order.order_number} безвозвратно (выезды, отчёты, файлы)?
                      </span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteOrder()}
                          className="rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white"
                        >
                          Да, удалить
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteOrder(false)}
                          className="rounded-lg border border-black/[0.1] bg-white px-3 py-1.5 font-semibold dark:border-white/[0.1] dark:bg-[#15171C]"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  )}

                  {isAdmin && reopenOpen && (
                    <form onSubmit={handleReopen} className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        required
                        value={reopenReason}
                        onChange={(e) => setReopenReason(e.target.value)}
                        placeholder="Причина возврата в работу..."
                        className="min-w-[200px] flex-1 rounded-xl border border-amber-500/30 bg-white px-3 py-2 text-xs dark:bg-[#15171C]"
                      />
                      <button
                        type="submit"
                        disabled={busy}
                        className="rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white"
                      >
                        Подтвердить
                      </button>
                      <button
                        type="button"
                        onClick={() => setReopenOpen(false)}
                        className="rounded-xl border border-black/[0.1] px-3 py-2 text-xs font-semibold dark:border-white/[0.1]"
                      >
                        Отмена
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'info' && (
            <div className="space-y-4">
              <h3 className="font-display text-base font-bold">Выезды ({order.visits.length})</h3>
              {order.visits.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-black/[0.12] p-6 text-center text-sm text-zinc-500 dark:border-white/[0.12]">
                  У этого заказа пока нет запланированных выездов. Добавьте первый выезд ниже.
                </div>
              ) : (
                order.visits.map((v) => {
                  const vMeta = ORDER_STATUS_META[v.status] || ORDER_STATUS_META.planned;
                  const isReporting = reportingVisitId === v.id;
                  const isAssignedHere =
                    isAdmin ||
                    v.assignees.some((a) => a.user_id === user.id) ||
                    order.assignees.some((a) => a.id === user.id);

                  return (
                    <div
                      key={v.id}
                      className="rounded-2xl border border-black/[0.07] bg-[#F5F5F7]/55 p-4 dark:border-white/[0.08] dark:bg-[#0B0C10]"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2 text-xs">
                            <span className={`inline-flex items-center gap-1.5 font-semibold ${vMeta.textClass}`}>
                              <span className={`h-2 w-2 rounded-full ${vMeta.dotClass}`} />
                              {vMeta.label}
                            </span>
                            <span className="text-zinc-400">·</span>
                            <span className="font-medium text-zinc-600 tabular-nums dark:text-zinc-300">
                              {formatDateTimeRu(v.scheduled_at)}
                            </span>
                          </div>
                          <h3 className="mt-1 font-display text-base font-bold">{v.title}</h3>
                          {v.description && (
                            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                              {v.description}
                            </p>
                          )}
                        </div>

                        {isAssignedHere && (
                          <div className="flex flex-wrap items-center gap-2">
                            {isClosedLocked ? (
                              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-black/[0.1] bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-black/[0.03] dark:border-white/[0.1] dark:bg-[#15171C] dark:text-zinc-200">
                                <Upload className="h-3.5 w-3.5" />
                                <span>Добавить фото</span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  multiple
                                  className="hidden"
                                  onChange={(e) => void handleFileUpload(e, 'photo', v.id)}
                                />
                              </label>
                            ) : (
                              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-black/[0.1] bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-black/[0.03] dark:border-white/[0.1] dark:bg-[#15171C] dark:text-zinc-200">
                                <Upload className="h-3.5 w-3.5" />
                                <span>Фото / видео</span>
                                <input
                                  type="file"
                                  accept="image/*,video/*"
                                  multiple
                                  className="hidden"
                                  onChange={(e) => void handleFileUpload(e, 'photo', v.id)}
                                />
                              </label>
                            )}
                            {!isClosedLocked && (
                              <button
                                type="button"
                                onClick={() =>
                                  setReportingVisitId(isReporting ? null : v.id)
                                }
                                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#0077ED] dark:bg-[#2997FF] dark:text-[#0B0C10]"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                <span>
                                  {v.status === 'completed'
                                    ? 'Добавить доп. отчёт'
                                    : 'Завершить и сдать отчёт'}
                                </span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Assignees + Admin Wage Control */}
                      {v.assignees.length > 0 && (
                        <div className="mt-3 space-y-1.5 border-t border-black/[0.06] pt-2.5 dark:border-white/[0.06]">
                          {v.assignees.map((a) => {
                            const key = `${v.id}:${a.user_id}`;
                            return (
                              <div
                                key={a.id}
                                className="flex flex-wrap items-center justify-between gap-2 text-xs"
                              >
                                <div className="flex items-center gap-2">
                                  <UserCheck className="h-3.5 w-3.5 text-zinc-400" />
                                  <span className="font-medium">{a.full_name}</span>
                                  {a.wage_kopecks !== undefined && a.wage_kopecks !== null ? (
                                    <span className="font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
                                      {formatRub(a.wage_kopecks)}
                                    </span>
                                  ) : (
                                    (isAdmin || a.user_id === user.id) && (
                                      <span className="text-amber-600 dark:text-amber-400">
                                        Ожидает начисления
                                      </span>
                                    )
                                  )}
                                </div>

                                {isAdmin && (
                                  <div className="flex items-center gap-1.5">
                                    <input
                                      type="number"
                                      min={0}
                                      placeholder={
                                        a.wage_kopecks
                                          ? String(Math.round(a.wage_kopecks / 100))
                                          : 'Ставка ₽'
                                      }
                                      value={wageInputs[key] ?? ''}
                                      onChange={(e) =>
                                        setWageInputs((prev) => ({
                                          ...prev,
                                          [key]: e.target.value,
                                        }))
                                      }
                                      className="w-24 rounded-lg border border-black/[0.1] bg-white px-2.5 py-1 text-xs tabular-nums dark:border-white/[0.1] dark:bg-[#15171C]"
                                    />
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void handleAssignWage(v.id, a.user_id)}
                                      className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                                    >
                                      Начислить
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {isAssignedHere && (
                        <VisitWorkTime
                          orderId={order.id}
                          visitId={v.id}
                          defaultDate={v.scheduled_at.slice(0, 10)}
                          isAdmin={isAdmin}
                          reports={v.reports}
                          shifts={v.shifts}
                          currentUserId={user.id}
                        />
                      )}

                      {/* Visit Report Form */}
                      {isReporting && !isClosedLocked && (
                        <form
                          onSubmit={(e) =>
                            void handleSubmitReport(e, v.id, v.status !== 'completed')
                          }
                          className="mt-3 space-y-2.5 rounded-xl border border-[#0071E3]/25 bg-white p-3.5 dark:bg-[#15171C]"
                        >
                          {isAdmin ? (
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="mb-1 block text-[11px] text-zinc-500">Начало</label>
                                <input
                                  type="time"
                                  value={repStart}
                                  onChange={(e) => setRepStart(e.target.value)}
                                  className="w-full rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[11px] text-zinc-500">Завершение</label>
                                <input
                                  type="time"
                                  value={repEnd}
                                  onChange={(e) => setRepEnd(e.target.value)}
                                  className="w-full rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                                />
                              </div>
                            </div>
                          ) : (
                            <div className="rounded-lg bg-[#F5F5F7] px-3 py-2 text-[11px] text-zinc-500 dark:bg-[#0B0C10]">
                              Время работы по выезду подтягивается из таймера «Начать смену»
                            </div>
                          )}
                          <div>
                            <label className="mb-1 block text-[11px] text-zinc-500">
                              Что сделано *
                            </label>
                            <textarea
                              required
                              rows={2}
                              value={repWork}
                              onChange={(e) => setRepWork(e.target.value)}
                              placeholder="Подробно опишите выполненный монтаж..."
                              className="w-full rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] text-zinc-500">
                              Замечания / комментарии
                            </label>
                            <input
                              type="text"
                              value={repNotes}
                              onChange={(e) => setRepNotes(e.target.value)}
                              placeholder="Если есть особенности на объекте..."
                              className="w-full rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-black/[0.1] px-3 py-1.5 text-xs font-medium hover:bg-black/[0.03] dark:border-white/[0.1]">
                              <Upload className="h-3.5 w-3.5" />
                              <span>Фото к выезду</span>
                              <input
                                type="file"
                                accept="image/*,video/*"
                                multiple
                                className="hidden"
                                onChange={(e) => void handleFileUpload(e, 'photo', v.id)}
                              />
                            </label>
                            <button
                              type="submit"
                              disabled={busy}
                              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                            >
                              {v.status === 'completed' ? 'Сохранить отчёт' : 'Завершить выезд'}
                            </button>
                          </div>
                        </form>
                      )}

                      {/* Submitted Reports */}
                      {v.reports.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {v.reports.map((rep) => {
                            const canModRep = isAdmin || (rep.user_id === user.id && !isClosedLocked);
                            const isEdRep = editingReportId === rep.id;
                            const isDelRep = confirmDeleteReportId === rep.id;
                            return (
                              <div
                                key={rep.id}
                                className="rounded-xl border border-black/[0.05] bg-white p-3 text-xs dark:border-white/[0.06] dark:bg-[#15171C]"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 text-zinc-500">
                                  <span className="font-semibold text-[#1D1D1F] dark:text-white">
                                    {rep.author_name} {rep.is_primary === 1 ? '· Основной отчёт' : '· Доп. отчёт'}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <span className="tabular-nums">
                                      {rep.start_time && rep.end_time
                                        ? `${rep.start_time}–${rep.end_time}`
                                        : formatDateTimeRu(rep.created_at)}
                                    </span>
                                    {canModRep && !isEdRep && (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setEditingReportId(rep.id);
                                            setEditRepStart(rep.start_time || '');
                                            setEditRepEnd(rep.end_time || '');
                                            setEditRepWork(rep.work_done);
                                            setEditRepNotes(rep.notes || '');
                                            setConfirmDeleteReportId(null);
                                          }}
                                          title="Редактировать отчёт"
                                          className="text-zinc-400 hover:text-[#0071E3]"
                                        >
                                          <Pencil className="h-3.5 w-3.5" />
                                        </button>
                                        {!isDelRep ? (
                                          <button
                                            type="button"
                                            onClick={() => setConfirmDeleteReportId(rep.id)}
                                            title="Удалить отчёт"
                                            className="text-zinc-400 hover:text-red-600"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        ) : (
                                          <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px]">
                                            <button
                                              type="button"
                                              disabled={busy}
                                              onClick={() => void handleDeleteReport(v.id, rep.id)}
                                              className="font-semibold text-red-600"
                                            >
                                              Удалить
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => setConfirmDeleteReportId(null)}
                                              className="text-zinc-400"
                                            >
                                              Отм.
                                            </button>
                                          </span>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                                {isEdRep ? (
                                  <form
                                    onSubmit={(e) => void handleEditReportSubmit(e, v.id, rep.id)}
                                    className="mt-2 space-y-2 border-t border-black/[0.06] pt-2 dark:border-white/[0.06]"
                                  >
                                    {isAdmin && (
                                      <div className="grid grid-cols-2 gap-2">
                                        <input
                                          type="time"
                                          value={editRepStart}
                                          onChange={(e) => setEditRepStart(e.target.value)}
                                          className="rounded-lg border border-black/[0.1] px-2 py-1 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                                        />
                                        <input
                                          type="time"
                                          value={editRepEnd}
                                          onChange={(e) => setEditRepEnd(e.target.value)}
                                          className="rounded-lg border border-black/[0.1] px-2 py-1 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                                        />
                                      </div>
                                    )}
                                    <textarea
                                      required
                                      rows={2}
                                      value={editRepWork}
                                      onChange={(e) => setEditRepWork(e.target.value)}
                                      className="w-full rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                                    />
                                    <input
                                      type="text"
                                      value={editRepNotes}
                                      onChange={(e) => setEditRepNotes(e.target.value)}
                                      placeholder="Примечания"
                                      className="w-full rounded-lg border border-black/[0.1] px-2.5 py-1.5 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]"
                                    />
                                    <div className="flex gap-1.5">
                                      <button
                                        type="submit"
                                        disabled={busy}
                                        className="inline-flex items-center gap-1 rounded-lg bg-[#0071E3] px-2.5 py-1 text-[11px] font-semibold text-white"
                                      >
                                        <Check className="h-3 w-3" />
                                        Сохранить
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingReportId(null)}
                                        className="rounded-lg border border-black/[0.1] px-2.5 py-1 text-[11px] dark:border-white/[0.1]"
                                      >
                                        Отмена
                                      </button>
                                    </div>
                                  </form>
                                ) : (
                                  <>
                                    <p className="mt-1 text-zinc-700 dark:text-zinc-200">{rep.work_done}</p>
                                    {rep.notes && (
                                      <p className="mt-1 text-zinc-400">{rep.notes}</p>
                                    )}
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Visit Photos */}
                      {v.attachments.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {v.attachments.map((att) => (
                            <div
                              key={att.id}
                              className="group relative overflow-hidden rounded-xl border border-black/[0.08] dark:border-white/[0.1]"
                            >
                              {att.mime_type.startsWith('image/') ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPreviewImage({
                                      url: `/api/orders/attachments/${att.id}`,
                                      title: att.original_name,
                                    })
                                  }
                                  className="block cursor-zoom-in"
                                >
                                  <img
                                    src={`/api/orders/attachments/${att.id}`}
                                    alt={att.original_name}
                                    referrerPolicy="no-referrer"
                                    className="h-16 w-16 object-cover"
                                  />
                                </button>
                              ) : att.mime_type.startsWith('video/') ? (
                                <video
                                  controls
                                  preload="metadata"
                                  src={`/api/orders/attachments/${att.id}`}
                                  className="h-16 w-28 bg-black object-contain"
                                />
                              ) : (
                                <a
                                  href={`/api/orders/attachments/${att.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block"
                                >
                                  <span className="flex h-16 items-center px-3 text-xs">
                                    {att.original_name}
                                  </span>
                                </a>
                              )}
                              {canEditOrder && !isClosedLocked && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleDeleteAttachment(att.id)}
                                  title="Удалить файл"
                                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-black/65 text-white opacity-90 hover:bg-red-600"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {canEditOrder && !isClosedLocked && (
                <form
                  onSubmit={handleAddVisit}
                  className="rounded-2xl border border-black/[0.06] bg-white p-4 dark:border-white/[0.08] dark:bg-[#0B0C10]"
                >
                  <div className="mb-2.5 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    Добавить дополнительный выезд (многодневный монтаж)
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      type="text"
                      value={newVisitTitle}
                      onChange={(e) => setNewVisitTitle(e.target.value)}
                      placeholder="Название этапа (напр. День 2: Натяжка)"
                      className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                    <input
                      type="datetime-local"
                      required
                      value={newVisitDate}
                      onChange={(e) => setNewVisitDate(e.target.value)}
                      className="rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.1] dark:bg-[#15171C]"
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {directory.map((d) => {
                      const active = newVisitAssignees.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() =>
                            setNewVisitAssignees((prev) =>
                              prev.includes(d.id) ? prev.filter((x) => x !== d.id) : [...prev, d.id]
                            )
                          }
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
                            active
                              ? 'bg-[#0071E3] text-white'
                              : 'bg-black/[0.05] text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300'
                          }`}
                        >
                          {d.fullName}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Добавить выезд</span>
                  </button>
                </form>
              )}
            </div>
          )}

          {tab === 'warehouse' && (
            <div className="space-y-4">
              {canTakeWarehouse && !isClosedLocked && (() => {
                const qtyNet = new Map<string, number>();
                for (const op of order.warehouseOps) {
                  if (op.item_type === 'tool' && op.tool_id && !op.tool_instance_id) {
                    const prev = qtyNet.get(op.tool_id) || 0;
                    if (op.op_type === 'issue') qtyNet.set(op.tool_id, prev + Number(op.qty_milli || 0));
                    else if (op.op_type === 'return') qtyNet.set(op.tool_id, prev - Number(op.qty_milli || 0));
                  }
                }
                const hasQtyOpen = [...qtyNet.values()].some((v) => v > 0);
                const hasIndOpen = tools.some((t) =>
                  t.instances.some((inst) => inst.status === 'issued' && inst.current_order_id === order.id)
                );
                if (!hasQtyOpen && !hasIndOpen) return null;
                return (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3">
                    <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                      На объекте числится невозвращённый инструмент
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          const res = await apiRequest<{ order?: Order; returnedCount?: number }>(
                            `/api/orders/${order.id}/tools/return-all`,
                            { method: 'POST', body: {}, skipOfflineQueue: true }
                          );
                          if (res.order) onOrderUpdated(res.order);
                          onWarehouseRefresh();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Ошибка возврата инструментов');
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Вернуть все инструменты с объекта</span>
                    </button>
                  </div>
                );
              })()}

              {order.plannedResources.length > 0 && (
                <div className="rounded-2xl border border-black/[0.06] bg-[#F5F5F7]/70 p-4 dark:border-white/[0.08] dark:bg-[#0B0C10]">
                  <div className="mb-2 text-xs font-semibold text-zinc-500">
                    Рекомендовано и зарезервировано для заказа
                  </div>
                  <div className="space-y-2 text-sm">
                    {order.plannedResources.map((pr) => (
                      <div key={pr.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/70 px-3 py-2 dark:bg-[#15171C]/70">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">
                            {pr.item_type === 'material'
                              ? pr.material_name
                              : `${pr.tool_emoji || '🔧'} ${pr.tool_name}`}
                          </span>
                          <span className="ml-2 font-semibold tabular-nums">
                            {formatQty(pr.planned_qty_milli)} {pr.material_unit || 'шт'}
                          </span>
                          {(pr.shortage_milli || 0) > 0 && (
                            <span className="ml-2 text-xs font-medium text-red-600">
                              Нехватка: {formatQty(pr.shortage_milli)} {pr.material_unit || 'шт'}
                            </span>
                          )}
                        </div>
                        {canTakeWarehouse && !isClosedLocked && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleQuickResourceOp(pr, 'issue')}
                              className="rounded-lg bg-[#0071E3] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#0077ED] disabled:opacity-50 dark:bg-[#2997FF] dark:text-[#0B0C10]"
                            >
                              Взял
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleQuickResourceOp(pr, 'return')}
                              className="rounded-lg bg-emerald-600/12 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-600/20 disabled:opacity-50 dark:text-emerald-300"
                            >
                              Вернул
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border border-black/[0.08] px-2.5 py-1 text-xs font-semibold text-zinc-600 hover:bg-black/[0.04] dark:border-white/[0.1] dark:text-zinc-300"
                              onClick={() => {
                                setWhMode(pr.item_type);
                                setWhOpType('issue');
                                if (pr.material_id) setWhMatId(pr.material_id);
                                if (pr.tool_id) {
                                  setWhToolId(pr.tool_id);
                                  setWhToolInstanceId('');
                                }
                                setWhQty(String((pr.reserved_remaining_milli || pr.planned_qty_milli) / 1000));
                              }}
                            >
                              В форму
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {canTakeWarehouse && !isClosedLocked && (
                <form
                  onSubmit={handleWarehouseAction}
                  className="rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.08]"
                >
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                      Операция со складом по заказу
                    </span>
                    <div className="flex rounded-xl bg-[#F5F5F7] p-0.5 dark:bg-[#0B0C10]">
                      <button
                        type="button"
                        onClick={() => setWhMode('material')}
                        className={`rounded-lg px-3 py-1 text-xs font-semibold ${
                          whMode === 'material'
                            ? 'bg-white shadow-xs dark:bg-[#15171C]'
                            : 'text-zinc-500'
                        }`}
                      >
                        Материал
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWhMode('tool');
                          if (whOpType === 'consume') setWhOpType('issue');
                        }}
                        className={`rounded-lg px-3 py-1 text-xs font-semibold ${
                          whMode === 'tool'
                            ? 'bg-white shadow-xs dark:bg-[#15171C]'
                            : 'text-zinc-500'
                        }`}
                      >
                        Инструмент
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    <select
                      value={whOpType}
                      onChange={(e) => setWhOpType(e.target.value as any)}
                      className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                    >
                      <option value="issue">Взять со склада</option>
                      {whMode === 'material' && <option value="consume">Израсходовано (списать)</option>}
                      <option value="return">Вернуть на склад</option>
                    </select>

                    {whMode === 'material' ? (
                      <select
                        value={whMatId}
                        onChange={(e) => setWhMatId(e.target.value)}
                        className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs sm:col-span-2 dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      >
                        {materials.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} (остаток: {formatQty(m.quantity_milli)} {m.unit})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select
                        value={whToolId}
                        onChange={(e) => {
                          setWhToolId(e.target.value);
                          setWhToolInstanceId('');
                        }}
                        className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs sm:col-span-2 dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      >
                        {tools.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.icon_emoji} {t.name} (свободно: {t.available_qty}/{t.total_qty})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    {whMode === 'tool' && selectedToolObj?.tracking_mode === 'individual' ? (
                      <select
                        value={whToolInstanceId}
                        onChange={(e) => setWhToolInstanceId(e.target.value)}
                        className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      >
                        <option value="">Любой свободный / выберите №</option>
                        {selectedToolObj.instances
                          .filter((inst) =>
                            whOpType === 'return'
                              ? inst.status === 'issued'
                              : inst.status === 'available'
                          )
                          .map((inst) => (
                            <option key={inst.id} value={inst.id}>
                              #{inst.serial_number} {inst.holder_name ? `(${inst.holder_name})` : ''}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        step={whMode === 'material' ? '0.1' : '1'}
                        min="0.1"
                        value={whQty}
                        onChange={(e) => setWhQty(e.target.value)}
                        placeholder="Количество"
                        className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs tabular-nums dark:border-white/[0.12] dark:bg-[#0B0C10]"
                      />
                    )}

                    <input
                      type="text"
                      value={whNote}
                      onChange={(e) => setWhNote(e.target.value)}
                      placeholder="Примечание (опционально)"
                      className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3 py-2 text-xs sm:col-span-2 dark:border-white/[0.12] dark:bg-[#0B0C10]"
                    />
                  </div>

                  {whConfirmReserved ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                      <span className="font-medium text-amber-800 dark:text-amber-200">
                        Часть материала или инструмента может быть зарезервирована для других заказов. Продолжить?
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleWarehouseAction(undefined, true)}
                          className="rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700"
                        >
                          Подтвердить
                        </button>
                        <button
                          type="button"
                          onClick={() => setWhConfirmReserved(false)}
                          className="rounded-lg border border-black/[0.1] px-2.5 py-1.5 font-semibold dark:border-white/[0.1]"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="submit"
                      disabled={busy}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
                    >
                      <Wrench className="h-3.5 w-3.5" />
                      <span>Выполнить операцию</span>
                    </button>
                  )}
                </form>
              )}

              <div>
                <div className="mb-2 text-xs font-semibold text-zinc-500">История по заказу</div>
                {order.warehouseOps.length === 0 ? (
                  <div className="text-sm text-zinc-400">Операций со складом по заказу ещё не было</div>
                ) : (
                  <div className="space-y-1.5">
                    {order.warehouseOps.map((op) => (
                      <div
                        key={op.id}
                        className="flex items-center justify-between rounded-xl border border-black/[0.06] px-3.5 py-2.5 text-xs dark:border-white/[0.08]"
                      >
                        <div>
                          <span className="font-semibold">
                            {op.material_name || op.tool_name}
                            {op.tool_serial ? ` #${op.tool_serial}` : ''}
                          </span>
                          <span className="mx-1.5 text-zinc-300">·</span>
                          <span className="text-zinc-500">{OP_TYPE_LABELS[op.op_type] || op.op_type}</span>
                          {op.employee_name && (
                            <>
                              <span className="mx-1.5 text-zinc-300">·</span>
                              <span className="text-zinc-500">{op.employee_name}</span>
                            </>
                          )}
                        </div>
                        <span className="font-semibold tabular-nums">
                          {formatQty(op.qty_milli)} {op.material_unit || 'шт'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'files' && (
            <div className="space-y-4">
              {order.visits.some(visit => visit.attachments.length > 0) && (
                <div className="rounded-2xl border border-black/[0.08] p-4 dark:border-white/[0.1]">
                  <h3 className="mb-2 text-sm font-semibold">Файлы выездов и отчётности</h3>
                  {order.visits.filter(visit => visit.attachments.length > 0).map(visit => (
                    <div key={visit.id} className="mt-3 space-y-1">
                      <div className="text-xs font-semibold text-zinc-500">{visit.title}</div>
                      {visit.attachments.map(file => <a key={file.id} href={`/api/orders/attachments/${file.id}`} target="_blank" rel="noreferrer" className="block break-all text-sm text-[#0071E3] underline dark:text-[#71b5ff]">{file.original_name}</a>)}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {isClosedLocked ? (
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]">
                    <ImageIcon className="h-4 w-4" />
                    <span>Фото</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => void handleFileUpload(e, 'photo')}
                    />
                  </label>
                ) : (
                  <>
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]">
                      <ImageIcon className="h-4 w-4" />
                      <span>Фото / видео</span>
                      <input
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        className="hidden"
                        onChange={(e) => void handleFileUpload(e, 'photo')}
                      />
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-black/[0.1] px-4 py-2.5 text-xs font-semibold hover:bg-black/[0.03] dark:border-white/[0.1]">
                      <FileText className="h-4 w-4" />
                      <span>Прикрепить документ (PDF / DOCX / XLSX)</span>
                      <input
                        type="file"
                        accept=".pdf,.doc,.docx,.xls,.xlsx,.txt"
                        multiple
                        className="hidden"
                        onChange={(e) => void handleFileUpload(e, 'document')}
                      />
                    </label>
                  </>
                )}
              </div>

              {order.attachments.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-black/[0.1] p-8 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
                  Прикреплённых фотографий и макетов пока нет
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {order.attachments.map((att) => (
                    <div
                      key={att.id}
                      className="group relative overflow-hidden rounded-2xl border border-black/[0.07] bg-[#F5F5F7] transition hover:border-[#0071E3] dark:border-white/[0.08] dark:bg-[#0B0C10]"
                    >
                      {att.mime_type.startsWith('video/') ? (
                        <div>
                          <video controls preload="metadata" src={`/api/orders/attachments/${att.id}`} className="h-32 w-full bg-black object-contain" />
                          <div className="truncate p-2.5 text-xs font-medium">{att.original_name}</div>
                        </div>
                      ) : att.mime_type.startsWith('image/') ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewImage({
                              url: `/api/orders/attachments/${att.id}`,
                              title: att.original_name,
                            })
                          }
                          className="block w-full cursor-zoom-in text-left"
                        >
                          <img
                            src={`/api/orders/attachments/${att.id}`}
                            alt={att.original_name}
                            referrerPolicy="no-referrer"
                            className="h-32 w-full object-cover"
                          />
                          <div className="truncate p-2.5 text-xs font-medium">{att.original_name}</div>
                        </button>
                      ) : (
                        <a
                          href={`/api/orders/attachments/${att.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="block"
                        >
                          <div className="flex h-32 items-center justify-center text-zinc-400">
                            <FileText className="h-10 w-10" />
                          </div>
                          <div className="truncate p-2.5 text-xs font-medium">{att.original_name}</div>
                        </a>
                      )}
                      {canEditOrder && !isClosedLocked && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteAttachment(att.id)}
                          title="Удалить файл"
                          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg bg-black/65 text-white hover:bg-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {previewImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="relative flex max-w-4xl flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Закрыть просмотр"
              onClick={() => setPreviewImage(null)}
              className="self-end rounded-xl bg-white/15 p-2 text-white hover:bg-white/25"
            >
              <X className="h-5 w-5" />
            </button>
            <img
              src={previewImage.url}
              alt={previewImage.title}
              className="max-h-[85vh] max-w-full rounded-xl object-contain"
            />
            <div className="text-center text-xs text-white/80">{previewImage.title}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function VisitWorkTime({
  orderId,
  visitId,
  defaultDate,
  isAdmin,
  reports,
  shifts,
  currentUserId,
}: {
  orderId: string;
  visitId: string;
  defaultDate: string;
  isAdmin: boolean;
  reports?: Array<{ user_id: string; is_primary?: number; start_time?: string | null; end_time?: string | null }>;
  shifts?: Array<{
    id: string;
    user_id: string;
    employee_name: string;
    started_at: string;
    ended_at: string | null;
    work_date: string;
    status: 'active' | 'completed';
    work_done?: string;
    is_manual_entry?: number;
  }>;
  currentUserId?: string;
}) {
  const [items, setItems] = useState<Array<{user_id:string;full_name:string;work_date:string;start_time:string;end_time:string}>>([]);
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/orders/${encodeURIComponent(orderId)}/visits/${encodeURIComponent(visitId)}/work-times`;
  const load = async () => { const result = await apiRequest<{items:typeof items}>(base, {useCache:false}); setItems(result.items); };
  useEffect(() => { void load().catch(() => setError('Не удалось загрузить время работы.')); }, [orderId, visitId]);

  const reportMatch =
    reports?.find((r) => r.user_id === currentUserId && r.start_time && r.end_time) ||
    reports?.find((r) => r.is_primary === 1 && r.start_time && r.end_time) ||
    reports?.find((r) => r.start_time && r.end_time);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await apiRequest(base.replace(/work-times$/, 'work-time'), {method:'PUT',body:{workDate:date,startTime:start,endTime:end},skipOfflineQueue:true});
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось сохранить время.'); }
    finally { setBusy(false); }
  };

  const visibleShifts = (shifts || []).filter((s) => isAdmin || s.user_id === currentUserId);

  return <div className="mt-3 rounded-xl border border-black/10 p-3 dark:border-white/10">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-xs font-semibold">{isAdmin ? 'Время работы по выезду' : 'Моё время работы'}</h4>
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-1.5">
          {reportMatch?.start_time && reportMatch?.end_time && (
            <button
              type="button"
              onClick={() => {
                setStart(reportMatch.start_time || '');
                setEnd(reportMatch.end_time || '');
              }}
              className="rounded-lg bg-[#0071E3]/10 px-2.5 py-1 text-[11px] font-semibold text-[#0071E3] hover:bg-[#0071E3]/15 dark:text-[#71b5ff]"
            >
              По времени отчёта ({reportMatch.start_time}–{reportMatch.end_time})
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setStart('09:00');
              setEnd('18:00');
            }}
            className="rounded-lg bg-black/[0.05] px-2.5 py-1 text-[11px] font-semibold text-zinc-600 hover:bg-black/[0.1] dark:bg-white/[0.08] dark:text-zinc-300"
          >
            09:00–18:00
          </button>
        </div>
      )}
    </div>
    {isAdmin ? (
      <>
        <form onSubmit={save} className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-xs">Дата<input required type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-0.5 block rounded-lg border border-black/[0.1] bg-white p-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]" /></label>
          <label className="text-xs">Начало<input required type="time" value={start} onChange={e => setStart(e.target.value)} className="mt-0.5 block rounded-lg border border-black/[0.1] bg-white p-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]" /></label>
          <label className="text-xs">Окончание<input required type="time" value={end} onChange={e => setEnd(e.target.value)} className="mt-0.5 block rounded-lg border border-black/[0.1] bg-white p-2 text-xs dark:border-white/[0.1] dark:bg-[#0B0C10]" /></label>
          <button disabled={busy} className="rounded-lg bg-[#0071E3] px-3 py-2 text-xs text-white disabled:opacity-50">Сохранить</button>
        </form>
        <p className="mt-1 text-[11px] text-zinc-500">Если окончание раньше начала, работа завершилась на следующий день. Повторное сохранение за дату обновит запись.</p>
      </>
    ) : (
      <p className="mt-1 text-[11px] text-zinc-500">
        Время работы фиксируется таймером «Начать смену» и правится через вкладку «Смены» или администратором.
      </p>
    )}
    {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    {visibleShifts.map((sh) => {
      const mins = sh.ended_at
        ? Math.max(0, Math.round((Date.parse(sh.ended_at) - Date.parse(sh.started_at)) / 60_000))
        : null;
      return (
        <div key={sh.id} className="mt-1 text-xs text-zinc-600 dark:text-zinc-300 tabular-nums">
          {isAdmin && `${sh.employee_name} · `}
          {sh.work_date || sh.started_at.slice(0, 10)} ·{' '}
          {new Date(sh.started_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
          {sh.ended_at
            ? `–${new Date(sh.ended_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${formatDuration(mins)}`
            : ' · идёт смена'}
        </div>
      );
    })}
    {items.map(item => { const mins = (s:string) => Number(s.slice(0,2))*60+Number(s.slice(3)); const duration=(mins(item.end_time)-mins(item.start_time)+1440)%1440; return <div key={`${item.user_id}:${item.work_date}`} className="mt-1 text-xs text-zinc-500">{isAdmin && `${item.full_name} · `}{item.work_date} · {item.start_time}–{item.end_time} · {Math.floor(duration/60)} ч {duration%60} мин</div>; })}
  </div>;
}
