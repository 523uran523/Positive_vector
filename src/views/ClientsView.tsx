import React, { useState } from 'react';
import { Building2, Pencil, Phone, Plus, Search, Trash2, User, X } from 'lucide-react';
import { apiRequest, formatDateRu, formatRub } from '../lib/api';
import type { AuthUser, Company, Contact } from '../types/crm';

interface ClientsViewProps {
  user: AuthUser;
  companies: Company[];
  contacts: Contact[];
  onRefresh: () => void;
  onOpenOrderById: (orderId: string) => void;
}

export function ClientsView({
  user,
  companies,
  contacts,
  onRefresh,
  onOpenOrderById,
}: ClientsViewProps) {
  const isAdmin = user.role === 'admin';
  const canCreate = isAdmin || user.permissions['clients.create'] || user.permissions['orders.create'];
  const canEdit = isAdmin || user.permissions['clients.edit'];

  const [mode, setMode] = useState<'companies' | 'contacts'>('companies');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'company' | 'contact' | null>(null);
  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Company form
  const [compName, setCompName] = useState('');
  const [compInn, setCompInn] = useState('');
  const [compPhone, setCompPhone] = useState('');
  const [compEmail, setCompEmail] = useState('');
  const [compAddr, setCompAddr] = useState('');
  const [compReq, setCompReq] = useState('');
  const [compNotes, setCompNotes] = useState('');

  // Contact form
  const [ctName, setCtName] = useState('');
  const [ctCompanyId, setCtCompanyId] = useState('');
  const [ctPhone, setCtPhone] = useState('');
  const [ctEmail, setCtEmail] = useState('');
  const [ctPosition, setCtPosition] = useState('');
  const [ctNotes, setCtNotes] = useState('');

  const q = search.trim().toLowerCase();
  const filteredCompanies = companies.filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.phone.toLowerCase().includes(q) ||
      c.inn.toLowerCase().includes(q)
  );
  const filteredContacts = contacts.filter(
    (ct) =>
      !q ||
      ct.full_name.toLowerCase().includes(q) ||
      ct.phone.toLowerCase().includes(q) ||
      (ct.company_name || '').toLowerCase().includes(q)
  );

  const openCreateCompany = () => {
    setEditingCompanyId(null);
    setCompName('');
    setCompInn('');
    setCompPhone('');
    setCompEmail('');
    setCompAddr('');
    setCompReq('');
    setCompNotes('');
    setError('');
    setModal('company');
  };

  const openEditCompany = (comp: Company) => {
    setEditingCompanyId(comp.id);
    setCompName(comp.name);
    setCompInn(comp.inn || '');
    setCompPhone(comp.phone || '');
    setCompEmail(comp.email || '');
    setCompAddr(comp.address || '');
    setCompReq(comp.requisites || '');
    setCompNotes(comp.notes || '');
    setError('');
    setModal('company');
  };

  const openCreateContact = () => {
    setEditingContactId(null);
    setCtName('');
    setCtCompanyId('');
    setCtPhone('');
    setCtEmail('');
    setCtPosition('');
    setCtNotes('');
    setError('');
    setModal('contact');
  };

  const openEditContact = (ct: Contact) => {
    setEditingContactId(ct.id);
    setCtName(ct.full_name);
    setCtCompanyId(ct.company_id || '');
    setCtPhone(ct.phone || '');
    setCtEmail(ct.email || '');
    setCtPosition(ct.position || '');
    setCtNotes(ct.notes || '');
    setError('');
    setModal('contact');
  };

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        name: compName,
        inn: compInn,
        phone: compPhone,
        email: compEmail,
        address: compAddr,
        requisites: compReq,
        notes: compNotes,
      };
      const res = editingCompanyId
        ? await apiRequest<{ offlineQueued?: boolean }>(`/api/clients/companies/${editingCompanyId}`, {
            method: 'PATCH',
            body: payload,
            offlineLabel: `Обновление компании «${compName}»`,
          })
        : await apiRequest<{ offlineQueued?: boolean }>('/api/clients/companies', {
            method: 'POST',
            body: payload,
            offlineLabel: `Новая компания «${compName}»`,
          });
      setModal(null);
      setEditingCompanyId(null);
      if (res.offlineQueued) {
        setNotice('Сохранение компании поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения компании');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        fullName: ctName,
        companyId: ctCompanyId || null,
        phone: ctPhone,
        email: ctEmail,
        position: ctPosition,
        notes: ctNotes,
      };
      const res = editingContactId
        ? await apiRequest<{ offlineQueued?: boolean }>(`/api/clients/contacts/${editingContactId}`, {
            method: 'PATCH',
            body: payload,
            offlineLabel: `Обновление контакта «${ctName}»`,
          })
        : await apiRequest<{ offlineQueued?: boolean }>('/api/clients/contacts', {
            method: 'POST',
            body: payload,
            offlineLabel: `Новый контакт «${ctName}»`,
          });
      setModal(null);
      setEditingContactId(null);
      if (res.offlineQueued) {
        setNotice('Сохранение контакта поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения контакта');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCompany = async (comp: Company) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/clients/companies/${comp.id}`, {
        method: 'DELETE',
        offlineLabel: `Удаление компании «${comp.name}»`,
      });
      setConfirmDeleteKey(null);
      if (res.offlineQueued) {
        setNotice('Удаление компании поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления компании');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteContact = async (ct: Contact) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiRequest<{ offlineQueued?: boolean }>(`/api/clients/contacts/${ct.id}`, {
        method: 'DELETE',
        offlineLabel: `Удаление контакта «${ct.full_name}»`,
      });
      setConfirmDeleteKey(null);
      if (res.offlineQueued) {
        setNotice('Удаление контакта поставлено в офлайн-очередь.');
      } else {
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления контакта');
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
      {/* Toolbar */}
      <div className="flex flex-col justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:flex-row sm:items-center dark:border-white/[0.08] dark:bg-[#15171C]">
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl bg-[#F5F5F7] p-1 dark:bg-[#0B0C10]">
            <button
              type="button"
              onClick={() => setMode('companies')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                mode === 'companies'
                  ? 'bg-white text-[#1D1D1F] shadow-xs dark:bg-[#15171C] dark:text-white'
                  : 'text-zinc-500'
              }`}
            >
              <Building2 className="h-3.5 w-3.5" />
              <span>Компании ({companies.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('contacts')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                mode === 'contacts'
                  ? 'bg-white text-[#1D1D1F] shadow-xs dark:bg-[#15171C] dark:text-white'
                  : 'text-zinc-500'
              }`}
            >
              <User className="h-3.5 w-3.5" />
              <span>Контакты ({contacts.length})</span>
            </button>
          </div>
        </div>

        <div className="flex flex-1 items-center gap-2 sm:max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию, телефону..."
              className="w-full rounded-xl border border-black/[0.08] bg-[#F5F5F7]/70 py-2 pl-9 pr-3 text-sm outline-none focus:border-[#0071E3] focus:bg-white dark:focus:bg-[#0B0C10] dark:border-white/[0.1] dark:bg-[#0B0C10]"
            />
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => (mode === 'companies' ? openCreateCompany() : openCreateContact())}
              className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              <Plus className="h-4 w-4" />
              <span>{mode === 'companies' ? 'Компания' : 'Контакт'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Lists */}
      {mode === 'companies' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filteredCompanies.length === 0 ? (
            <div className="col-span-full rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
              Компании не найдены
            </div>
          ) : (
            filteredCompanies.map((comp) => (
              <div
                key={comp.id}
                className="rounded-2xl border border-black/[0.06] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-display text-base font-bold">{comp.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                      {comp.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {comp.phone}
                        </span>
                      )}
                      {comp.email && <span>{comp.email}</span>}
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    {isAdmin && comp.debt_kopecks !== undefined && comp.debt_kopecks > 0 && (
                      <div className="text-right">
                        <div className="text-[11px] text-zinc-400">Долг</div>
                        <div className="text-sm font-bold text-amber-600 tabular-nums dark:text-amber-400">
                          {formatRub(comp.debt_kopecks)}
                        </div>
                      </div>
                    )}
                    {canEdit && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEditCompany(comp)}
                          title="Редактировать компанию"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:text-[#0071E3] dark:border-white/[0.1] dark:text-zinc-400"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {confirmDeleteKey !== `comp:${comp.id}` ? (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteKey(`comp:${comp.id}`)}
                            title="Удалить компанию"
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:border-red-500/30 hover:text-red-600 dark:border-white/[0.1] dark:text-zinc-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <div className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px]">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleDeleteCompany(comp)}
                              className="font-semibold text-red-600"
                            >
                              Удал.
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteKey(null)}
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

                {comp.address && (
                  <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{comp.address}</div>
                )}
                {comp.notes && (
                  <div className="mt-1 text-xs text-zinc-500 italic dark:text-zinc-400">{comp.notes}</div>
                )}

                {comp.contacts && comp.contacts.length > 0 && (
                  <div className="mt-3 border-t border-black/[0.05] pt-2.5 dark:border-white/[0.06]">
                    <div className="mb-1 text-[11px] font-semibold text-zinc-400">Контакты</div>
                    <div className="space-y-1 text-xs">
                      {comp.contacts.map((ct) => (
                        <div key={ct.id} className="flex items-center justify-between">
                          <span className="font-medium">{ct.full_name}</span>
                          <span className="text-zinc-500">{ct.phone}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {comp.orders && comp.orders.length > 0 && (
                  <div className="mt-3 border-t border-black/[0.05] pt-2.5 dark:border-white/[0.06]">
                    <div className="mb-1.5 text-[11px] font-semibold text-zinc-400">
                      Заказы ({comp.orders.length})
                    </div>
                    <div className="space-y-1">
                      {comp.orders.slice(0, 4).map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => onOpenOrderById(o.id)}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                        >
                          <span className="truncate">
                            <span className="font-mono text-zinc-400">{o.order_number}</span>{' '}
                            <span className="font-medium">{o.title}</span>
                          </span>
                          <span className="ml-2 shrink-0 text-zinc-400 tabular-nums">
                            {isAdmin && o.price_kopecks !== undefined
                              ? formatRub(o.price_kopecks)
                              : formatDateRu(o.scheduled_at)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredContacts.length === 0 ? (
            <div className="col-span-full rounded-2xl border border-dashed border-black/[0.1] p-10 text-center text-sm text-zinc-400 dark:border-white/[0.1]">
              Контакты не найдены
            </div>
          ) : (
            filteredContacts.map((ct) => (
              <div
                key={ct.id}
                className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-[#15171C]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-display text-sm font-bold">{ct.full_name}</h3>
                    {ct.company_name && (
                      <div className="text-xs font-medium text-[#0071E3] dark:text-[#2997FF]">
                        {ct.company_name}
                      </div>
                    )}
                    {ct.position && (
                      <div className="text-xs text-zinc-500">{ct.position}</div>
                    )}
                  </div>
                  <div className="flex items-start gap-2">
                    {isAdmin && ct.debt_kopecks !== undefined && ct.debt_kopecks > 0 && (
                      <span className="text-xs font-bold text-amber-600 tabular-nums dark:text-amber-400">
                        Долг {formatRub(ct.debt_kopecks)}
                      </span>
                    )}
                    {canEdit && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEditContact(ct)}
                          title="Редактировать контакт"
                          className="flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:text-[#0071E3] dark:border-white/[0.1] dark:text-zinc-400"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {confirmDeleteKey !== `ct:${ct.id}` ? (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteKey(`ct:${ct.id}`)}
                            title="Удалить контакт"
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 hover:border-red-500/30 hover:text-red-600 dark:border-white/[0.1] dark:text-zinc-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <div className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px]">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleDeleteContact(ct)}
                              className="font-semibold text-red-600"
                            >
                              Удал.
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteKey(null)}
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
                <div className="mt-2 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-300">
                  {ct.phone && <div>{ct.phone}</div>}
                  {ct.email && <div className="text-zinc-400">{ct.email}</div>}
                  {ct.notes && <div className="text-zinc-400 italic">{ct.notes}</div>}
                </div>
                {ct.orders && ct.orders.length > 0 && (
                  <div className="mt-3 border-t border-black/[0.05] pt-2 dark:border-white/[0.06]">
                    <div className="mb-1 text-[11px] font-semibold text-zinc-400">
                      Заказы ({ct.orders.length})
                    </div>
                    <div className="space-y-1">
                      {ct.orders.slice(0, 3).map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => onOpenOrderById(o.id)}
                          className="flex w-full items-center justify-between rounded-lg px-1.5 py-1 text-left text-xs hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                        >
                          <span className="truncate">
                            <span className="font-mono text-zinc-400">{o.order_number}</span>{' '}
                            <span>{o.title}</span>
                          </span>
                          <span className="ml-2 shrink-0 text-zinc-400 tabular-nums">
                            {isAdmin && o.price_kopecks !== undefined
                              ? formatRub(o.price_kopecks)
                              : formatDateRu(o.scheduled_at)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Create / Edit Company Modal */}
      {modal === 'company' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleSaveCompany}
            className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {editingCompanyId ? 'Редактировать компанию' : 'Новая компания'}
              </h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <input
                type="text"
                required
                value={compName}
                onChange={(e) => setCompName(e.target.value)}
                placeholder="Название компании *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="tel"
                  value={compPhone}
                  onChange={(e) => setCompPhone(e.target.value)}
                  placeholder="Телефон"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
                <input
                  type="email"
                  value={compEmail}
                  onChange={(e) => setCompEmail(e.target.value)}
                  placeholder="Email"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
              <input
                type="text"
                value={compAddr}
                onChange={(e) => setCompAddr(e.target.value)}
                placeholder="Адрес"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <textarea
                rows={2}
                value={compNotes}
                onChange={(e) => setCompNotes(e.target.value)}
                placeholder="Заметки"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {busy ? 'Сохраняем...' : editingCompanyId ? 'Сохранить изменения' : 'Добавить компанию'}
            </button>
          </form>
        </div>
      )}

      {/* Create / Edit Contact Modal */}
      {modal === 'contact' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleSaveContact}
            className="w-full max-w-lg rounded-t-3xl border border-black/[0.08] bg-white p-6 shadow-2xl sm:rounded-3xl dark:border-white/[0.1] dark:bg-[#15171C]"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">
                {editingContactId ? 'Редактировать контакт' : 'Новый контакт'}
              </h3>
              <button type="button" onClick={() => setModal(null)} className="text-zinc-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            {error && <div className="mb-3 text-xs text-red-600">{error}</div>}
            <div className="space-y-3">
              <input
                type="text"
                required
                value={ctName}
                onChange={(e) => setCtName(e.target.value)}
                placeholder="ФИО контакта *"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <select
                value={ctCompanyId}
                onChange={(e) => setCtCompanyId(e.target.value)}
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              >
                <option value="">Без привязки к компании (частный клиент)</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="tel"
                  value={ctPhone}
                  onChange={(e) => setCtPhone(e.target.value)}
                  placeholder="Телефон"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
                <input
                  type="text"
                  value={ctPosition}
                  onChange={(e) => setCtPosition(e.target.value)}
                  placeholder="Должность"
                  className="rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
                />
              </div>
              <input
                type="email"
                value={ctEmail}
                onChange={(e) => setCtEmail(e.target.value)}
                placeholder="Email"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
              <textarea
                rows={2}
                value={ctNotes}
                onChange={(e) => setCtNotes(e.target.value)}
                placeholder="Заметки по контакту"
                className="w-full rounded-xl border border-black/[0.1] bg-[#F5F5F7]/70 px-3.5 py-2.5 text-sm dark:border-white/[0.12] dark:bg-[#0B0C10]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="mt-4 w-full rounded-2xl bg-[#0071E3] py-3 text-sm font-semibold text-white dark:bg-[#2997FF] dark:text-[#0B0C10]"
            >
              {busy ? 'Сохраняем...' : editingContactId ? 'Сохранить изменения' : 'Добавить контакт'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
