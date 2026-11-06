import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse } from './model.js';

/**
 * Edge staff id of a back-office employee (lane bo-ui, design-bo-ui.md 5.7, iiko-gap P0-5).
 *
 * The cashier edge knows its staff only by uuid (local_staff.id, set by the operator in the
 * scripts/staff-setup.mjs file), and the cloud receives only those ids (cashier, approver, who
 * recorded a Webkassa number). When the operator takes the id from scripts/edge-staff-id.mjs, the
 * back office can name the person: the id is a pure function of the employee card and the edge
 * role, so nothing new is stored on either side.
 *
 *   edgeStaffId(employee_id, role) = uuid of sha256('pickchick-edge-staff-v1:' + employee_id + ':'
 *   + role), the first 32 hex digits with the version and variant bits of localCatalogId
 *   (packages/menu-sync/src/availability.ts): version 8, variant 10xx.
 *
 * scripts/edge-staff-id.mjs carries its own copy (it runs on the edge server without this
 * package); EDGE_STAFF_ID_VECTOR pins both to the same bytes.
 */

/** Verbatim copy of StaffRoleSchema (packages/contracts): the roles of an edge staff account. */
export const EDGE_STAFF_ROLES = ['cashier', 'shift_manager', 'kitchen'] as const;
export type EdgeStaffRole = (typeof EDGE_STAFF_ROLES)[number];
export const EDGE_STAFF_ID_PREFIX = 'pickchick-edge-staff-v1:';

const EmployeeId = z.uuid();
const Role = z.enum(EDGE_STAFF_ROLES);

/** The edge staff id of `employeeId` in `role` (lower-case uuid, version 8). */
export function edgeStaffId(employeeId: string, role: EdgeStaffRole): string {
  const employee = parse(EmployeeId, employeeId).toLowerCase();
  const kind = parse(Role, role);
  const hash = createHash('sha256')
    .update(`${EDGE_STAFF_ID_PREFIX}${employee}:${kind}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hash[12] = '8';
  hash[16] = (8 | (parseInt(hash[16]!, 16) & 3)).toString(16);
  const h = hash.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One pinned vector shared by this module and scripts/edge-staff-id.mjs (synthetic employee). */
export const EDGE_STAFF_ID_VECTOR = Object.freeze({
  employee_id: '00000000-0000-4000-8000-000000000001',
  ids: Object.freeze({
    cashier: 'fb6bad12-a67f-8aca-adf0-009368a43895',
    shift_manager: '92f7cba7-3ad0-870c-8f8d-5242fd16f035',
    kitchen: '862e6be7-6ada-8ed6-894d-c675d36b8dda',
  }),
});

export type EdgeStaffName = { name: string; employee_id: string; role: EdgeStaffRole };
/**
 * Names of the edge staff ids in `ids`, from the employee cards of the branch (every card, also
 * inactive and deleted ones: an old sale keeps the name of whoever made it). An id that is not the
 * edge id of any card is left out; the screen then shows the short code.
 */
export function edgeStaffNames(
  employees: readonly { id: string; name: string }[],
  ids: Iterable<string | null | undefined>,
): Record<string, EdgeStaffName> {
  const wanted = new Set<string>();
  for (const id of ids) if (typeof id === 'string' && id) wanted.add(id.toLowerCase());
  const out: Record<string, EdgeStaffName> = {};
  if (!wanted.size) return out;
  for (const employee of employees) {
    if (!EmployeeId.safeParse(employee.id).success) continue;
    for (const role of EDGE_STAFF_ROLES) {
      const id = edgeStaffId(employee.id, role);
      if (wanted.has(id) && !out[id])
        out[id] = { name: employee.name, employee_id: employee.id.toLowerCase(), role };
    }
  }
  return Object.fromEntries(
    Object.keys(out)
      .sort()
      .map((id) => [id, out[id]!]),
  );
}
