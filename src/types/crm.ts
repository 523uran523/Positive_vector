export type PermissionKey =
  | 'orders.create'
  | 'orders.edit_assigned'
  | 'orders.view_all'
  | 'clients.create'
  | 'clients.edit'
  | 'clients.view_all'
  | 'reports.view_others'
  | 'warehouse.take'
  | 'warehouse.receive'
  | 'warehouse.edit';

export interface AuthUser {
  id: string;
  login: string;
  role: 'admin' | 'employee';
  accountingAccess: boolean;
  fullName: string;
  phone: string;
  position: string;
  shiftRateKopecks: number;
  isActive: boolean;
  dismissedAt: string | null;
  mustChangePassword: boolean;
  permissions: Record<PermissionKey, boolean>;
}

export interface DirectoryUser {
  id: string;
  fullName: string;
  role: 'admin' | 'employee';
  position: string;
}

export interface QuickTask {
  id: string;
  title: string;
  description: string;
  due_date: string;
  status: 'open' | 'completed' | 'cancelled';
  created_by: string;
  completed_by: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  completion_comment: string;
  created_at: string;
  updated_at: string;
  assignees: Array<{id:string;full_name:string}>;
}

export interface Company {
  id: string;
  name: string;
  inn: string;
  requisites: string;
  address: string;
  phone: string;
  email: string;
  notes: string;
  created_at: string;
  contacts?: Contact[];
  orders?: Array<{
    id: string;
    order_number: string;
    title: string;
    status: string;
    scheduled_at: string | null;
    price_kopecks?: number;
  }>;
  debt_kopecks?: number;
  total_orders?: number;
}

export interface Contact {
  id: string;
  company_id: string | null;
  company_name?: string | null;
  full_name: string;
  phone: string;
  email: string;
  position: string;
  notes: string;
  created_at: string;
  orders?: Array<{
    id: string;
    order_number: string;
    title: string;
    status: string;
    scheduled_at: string | null;
    price_kopecks?: number;
  }>;
  debt_kopecks?: number;
  total_orders?: number;
}

export interface VisitAssignee {
  id: string;
  user_id: string;
  is_lead: number;
  wage_kopecks?: number | null;
  wage_assigned_at?: string | null;
  full_name: string;
  position: string;
  phone: string;
}

export interface VisitReport {
  id: string;
  visit_id: string;
  order_id: string;
  user_id: string;
  author_name: string;
  is_primary: number;
  start_time: string;
  end_time: string;
  work_done: string;
  notes: string;
  created_at: string;
}

export interface AttachmentItem {
  id: string;
  kind: 'photo' | 'document';
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface OrderVisit {
  id: string;
  order_id: string;
  title: string;
  scheduled_at: string;
  description: string;
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled';
  actual_start_at: string | null;
  actual_end_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  assignees: VisitAssignee[];
  reports: VisitReport[];
  attachments: AttachmentItem[];
}

export interface PlannedResource {
  id: string;
  order_id: string;
  item_type: 'material' | 'tool';
  material_id: string | null;
  tool_id: string | null;
  planned_qty_milli: number;
  reserved_remaining_milli?: number;
  reserved_other_milli?: number;
  available_for_order_milli?: number;
  shortage_milli?: number;
  material_name?: string;
  material_unit?: string;
  tool_name?: string;
  tool_emoji?: string;
}

export interface WarehouseOp {
  id: string;
  item_type: 'material' | 'tool';
  material_id: string | null;
  tool_id: string | null;
  tool_instance_id: string | null;
  op_type: 'receipt' | 'issue' | 'consume' | 'return' | 'adjust';
  qty_milli: number;
  unit_cost_kopecks: number;
  order_id: string | null;
  visit_id: string | null;
  shift_id: string | null;
  user_id: string | null;
  note: string;
  created_at: string;
  material_name?: string;
  material_unit?: string;
  tool_name?: string;
  tool_serial?: string;
  employee_name?: string;
  order_number?: string;
}

export interface OrderPayment {
  id: string;
  amount_kopecks: number;
  payment_type: 'advance' | 'partial' | 'full';
  payment_method: 'cash' | 'bank' | 'card';
  paid_at: string;
  comment: string;
  created_at?: string;
}

export interface Order {
  id: string;
  order_number: string;
  title: string;
  status: 'new' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  scheduled_at: string | null;
  company_id: string | null;
  client_contact_id: string | null;
  site_contact_name: string;
  site_contact_phone: string;
  address: string;
  description: string;
  price_kopecks?: number;
  cost_override_kopecks?: number | null;
  paid_kopecks?: number;
  material_cost_kopecks?: number;
  auto_material_cost_kopecks?: number;
  payments?: OrderPayment[];
  tags: string[];
  comments: string;
  created_at: string;
  updated_at: string;
  company: { id: string; name: string; phone: string } | null;
  contact: { id: string; full_name: string; phone: string; position: string } | null;
  assignees: Array<{ id: string; full_name: string; position: string; phone: string }>;
  visits: OrderVisit[];
  attachments: AttachmentItem[];
  plannedResources: PlannedResource[];
  warehouseOps: WarehouseOp[];
  cancellationIssues?: {materials:Array<{id:string;name:string;unit:string;unconsumedIssuedMilli:number}>;tools:Array<{id:string;name:string;qty_milli:number}>;paymentsKopecks:number;accrualsKopecks:number;reviews:Array<{issue_key:string;reviewed_at:string;note:string}>};
}

export interface WorkshopShift {
  id: string;
  user_id: string;
  employee_name?: string;
  started_at: string;
  ended_at: string | null;
  work_done: string;
  status: 'active' | 'completed';
  rate_snapshot_kopecks: number;
  created_at: string;
}

export interface MaterialItem {
  id: string;
  name: string;
  category: string;
  unit: string;
  quantity_milli: number;
  reserved_milli?: number;
  purchase_price_kopecks: number;
  min_threshold_milli: number;
  created_at: string;
}

export interface ToolInstance {
  id: string;
  tool_id: string;
  serial_number: string;
  status: 'available' | 'issued' | 'maintenance';
  holder_user_id: string | null;
  holder_name?: string | null;
  current_order_id: string | null;
  order_number?: string | null;
  issued_at: string | null;
}

export interface ToolItem {
  id: string;
  name: string;
  color: string;
  icon_emoji: string;
  tracking_mode: 'quantity' | 'individual';
  total_qty: number;
  available_qty: number;
  reserved_milli?: number;
  notes: string;
  instances: ToolInstance[];
  activeHolders: Array<{ userId: string; holderName: string; qty: number }>;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link_entity_type: string | null;
  link_entity_id: string | null;
  is_read: number;
  created_at: string;
}

export interface AppSettings {
  company_name?: string;
  default_shift_rate_kopecks?: number;
  order_tags?: string[];
  expense_categories?: Array<{ key: string; label: string }>;
  units?: string[];
  material_categories?: string[];
  default_theme?: 'light' | 'dark';
  email_notifications?: { enabled: boolean; smtpHost: string; fromAddress: string };
}
