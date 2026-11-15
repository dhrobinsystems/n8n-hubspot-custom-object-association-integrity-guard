/**
 * Bundled demo schema and dataset. Every name is fictional sample data (Acme Corp, Example Company Inc.).
 * Demo mode runs whenever HUBSPOT_PRIVATE_APP_TOKEN is still a placeholder.
 */
import { loadGuardConfig } from './config.js';

export const DEMO_NOW = '2026-11-16T06:00:00.000Z';

export const DEMO_GUARD_DOCUMENT = Object.freeze({
  settings: { gracePeriodHours: 24, verifyTargetsExist: true },
  associationTypes: {
    project_to_company_primary: { fromObjectType: '2-1000001', toObjectType: 'companies', category: 'USER_DEFINED', typeId: 101, label: 'Primary Client' },
    shipment_to_deal_fulfils: { fromObjectType: '2-1000002', toObjectType: 'deals', category: 'USER_DEFINED', typeId: 201, label: 'Fulfils' },
  },
  rules: [
    {
      key: 'projects',
      label: 'Projects',
      objectTypeId: '2-1000001',
      displayProperty: 'project_name',
      skipWhen: [{ property: 'project_status', in: ['cancelled'] }],
      requirements: [
        { key: 'primary_company', label: 'Primary client company', toObjectType: 'companies', associationType: 'project_to_company_primary', min: 1, max: 1, severity: 'critical' },
        { key: 'deal', label: 'Open or won deal', toObjectType: 'deals', min: 1, severity: 'critical', targetWhen: [{ property: 'dealstage', notIn: ['closedlost'] }] },
      ],
    },
    {
      key: 'shipments',
      label: 'Shipments',
      objectTypeId: '2-1000002',
      displayProperty: 'shipment_reference',
      skipWhen: [{ property: 'shipment_status', in: ['cancelled'] }],
      requirements: [
        { key: 'fulfilment_deal', label: 'Fulfilment deal', toObjectType: 'deals', associationType: 'shipment_to_deal_fulfils', min: 1, max: 1, severity: 'critical' },
        { key: 'company', label: 'Company', toObjectType: 'companies', min: 1, severity: 'warning' },
      ],
    },
    {
      key: 'service_tickets',
      label: 'Service Tickets',
      objectTypeId: '2-1000003',
      displayProperty: 'ticket_subject',
      onlyWhen: [{ property: 'ticket_status', notIn: ['archived'] }],
      requirements: [
        { key: 'customer_company', label: 'Customer company', toObjectType: 'companies', min: 1, severity: 'critical', targetWhen: [{ property: 'lifecyclestage', in: ['customer'] }] },
        { key: 'warranty_deal', label: 'Warranty deal', toObjectType: 'deals', min: 1, severity: 'critical', when: [{ property: 'ticket_type', in: ['warranty'] }] },
      ],
    },
  ],
});

const OLD = '2026-06-02T09:00:00.000Z';
const PRIMARY = [{ category: 'USER_DEFINED', typeId: 101, label: 'Primary Client' }];
const UNLABELED_COMPANY = [{ category: 'HUBSPOT_DEFINED', typeId: 990, label: null }];
const FULFILS = [{ category: 'USER_DEFINED', typeId: 201, label: 'Fulfils' }];
const UNLABELED_DEAL = [{ category: 'HUBSPOT_DEFINED', typeId: 991, label: null }];

function edge(fromType, fromId, toType, toId, types) {
  return { fromType, fromId: String(fromId), toType, toId: String(toId), types };
}

/** Returns a fresh, mutable copy of the demo portal. */
export function createDemoState() {
  return {
    account: { portalId: 'DEMO', accountType: 'SANDBOX', dataHostingLocation: 'na1', timeZone: 'UTC' },
    maxPageSize: 100,
    objects: {
      companies: {
        3001: { createdAt: OLD, properties: { name: 'Acme Corp', lifecyclestage: 'customer' } },
        3002: { createdAt: OLD, properties: { name: 'Example Company Inc.', lifecyclestage: 'customer' } },
        3003: { createdAt: OLD, properties: { name: 'Example Prospect LLC', lifecyclestage: 'lead' } },
      },
      deals: {
        4001: { createdAt: OLD, properties: { dealname: 'Acme Corp - Platform rollout', dealstage: 'closedwon' } },
        4002: { createdAt: OLD, properties: { dealname: 'Example Company Inc. - Renewal', dealstage: 'contractsent' } },
        4003: { createdAt: OLD, properties: { dealname: 'Example Company Inc. - Expansion', dealstage: 'closedlost' } },
      },
      '2-1000001': {
        1001: { createdAt: OLD, properties: { project_name: 'Acme Corp onboarding', project_status: 'active' } },
        1002: { createdAt: OLD, properties: { project_name: 'Unlinked migration project', project_status: 'active' } },
        1003: { createdAt: OLD, properties: { project_name: 'Example Company data audit', project_status: 'active' } },
        1004: { createdAt: OLD, properties: { project_name: 'Shared implementation', project_status: 'active' } },
        1005: { createdAt: OLD, properties: { project_name: 'Lost expansion workstream', project_status: 'active' } },
        1006: { createdAt: '2026-11-16T01:00:00.000Z', properties: { project_name: 'Project created this morning', project_status: 'active' } },
        1007: { createdAt: OLD, properties: { project_name: 'Cancelled pilot', project_status: 'cancelled' } },
        1008: { createdAt: OLD, properties: { project_name: 'Renewal enablement', project_status: 'active', association_integrity_status: 'orphaned', association_integrity_issues: 'Open or won deal: no association (needs at least 1)' } },
        1009: { createdAt: OLD, properties: { project_name: 'Project for a merged company', project_status: 'active' } },
      },
      '2-1000002': {
        2001: { createdAt: OLD, properties: { shipment_reference: 'SHP-0001', shipment_status: 'delivered' } },
        2002: { createdAt: OLD, properties: { shipment_reference: 'SHP-0002', shipment_status: 'in_transit' } },
        2003: { createdAt: OLD, properties: { shipment_reference: 'SHP-0003', shipment_status: 'in_transit' } },
        2004: { createdAt: OLD, properties: { shipment_reference: 'SHP-0004', shipment_status: 'pending', association_integrity_status: 'orphaned', association_integrity_issues: 'Fulfilment deal: no association (needs at least 1)' } },
        2005: { createdAt: OLD, properties: { shipment_reference: 'SHP-0005', shipment_status: 'cancelled' } },
      },
      '2-1000003': {
        5001: { createdAt: OLD, properties: { ticket_subject: 'Login issue', ticket_status: 'open', ticket_type: 'support' } },
        5002: { createdAt: OLD, properties: { ticket_subject: 'Pre-sales question logged as a ticket', ticket_status: 'open', ticket_type: 'support' } },
        5003: { createdAt: OLD, properties: { ticket_subject: 'Warranty replacement', ticket_status: 'open', ticket_type: 'warranty' } },
        5004: { createdAt: OLD, properties: { ticket_subject: 'Warranty repair', ticket_status: 'open', ticket_type: 'warranty' } },
        5005: { createdAt: OLD, properties: { ticket_subject: 'Old archived request', ticket_status: 'archived', ticket_type: 'support' } },
        5006: { createdAt: OLD, properties: { ticket_subject: 'Ticket with a read error', ticket_status: 'open', ticket_type: 'support' } },
      },
    },
    associations: [
      edge('2-1000001', 1001, 'companies', 3001, PRIMARY),
      edge('2-1000001', 1001, 'deals', 4001, UNLABELED_DEAL),
      edge('2-1000001', 1003, 'companies', 3002, UNLABELED_COMPANY),
      edge('2-1000001', 1003, 'deals', 4002, UNLABELED_DEAL),
      edge('2-1000001', 1004, 'companies', 3001, PRIMARY),
      edge('2-1000001', 1004, 'companies', 3002, PRIMARY),
      edge('2-1000001', 1004, 'deals', 4001, UNLABELED_DEAL),
      edge('2-1000001', 1005, 'companies', 3001, PRIMARY),
      edge('2-1000001', 1005, 'deals', 4003, UNLABELED_DEAL),
      edge('2-1000001', 1008, 'companies', 3002, PRIMARY),
      edge('2-1000001', 1008, 'deals', 4002, UNLABELED_DEAL),
      edge('2-1000001', 1009, 'companies', 3999, PRIMARY),
      edge('2-1000001', 1009, 'deals', 4001, UNLABELED_DEAL),
      edge('2-1000002', 2001, 'deals', 4001, FULFILS),
      edge('2-1000002', 2001, 'companies', 3001, UNLABELED_COMPANY),
      edge('2-1000002', 2002, 'deals', 4002, FULFILS),
      edge('2-1000002', 2003, 'companies', 3001, UNLABELED_COMPANY),
      edge('2-1000002', 2004, 'companies', 3002, UNLABELED_COMPANY),
      edge('2-1000003', 5001, 'companies', 3001, UNLABELED_COMPANY),
      edge('2-1000003', 5002, 'companies', 3003, UNLABELED_COMPANY),
      edge('2-1000003', 5003, 'companies', 3002, UNLABELED_COMPANY),
      edge('2-1000003', 5004, 'companies', 3002, UNLABELED_COMPANY),
      edge('2-1000003', 5004, 'deals', 4002, UNLABELED_DEAL),
      edge('2-1000003', 5006, 'companies', 3001, UNLABELED_COMPANY),
    ],
    faults: { associationErrors: [{ fromType: '2-1000003', toType: 'companies', id: '5006' }] },
    schemas: [
      { objectTypeId: '2-1000001', name: 'projects', fullyQualifiedName: 'p_demo_projects', labels: { singular: 'Project', plural: 'Projects' } },
      { objectTypeId: '2-1000002', name: 'shipments', fullyQualifiedName: 'p_demo_shipments', labels: { singular: 'Shipment', plural: 'Shipments' } },
      { objectTypeId: '2-1000003', name: 'service_tickets', fullyQualifiedName: 'p_demo_service_tickets', labels: { singular: 'Service Ticket', plural: 'Service Tickets' } },
    ],
    labels: {
      '2-1000001|companies': [{ category: 'HUBSPOT_DEFINED', typeId: 990, label: null }, { category: 'USER_DEFINED', typeId: 101, label: 'Primary Client' }],
      '2-1000001|deals': [{ category: 'HUBSPOT_DEFINED', typeId: 991, label: null }],
      '2-1000002|deals': [{ category: 'HUBSPOT_DEFINED', typeId: 991, label: null }, { category: 'USER_DEFINED', typeId: 201, label: 'Fulfils' }],
      '2-1000002|companies': [{ category: 'HUBSPOT_DEFINED', typeId: 990, label: null }],
      '2-1000003|companies': [{ category: 'HUBSPOT_DEFINED', typeId: 990, label: null }],
      '2-1000003|deals': [{ category: 'HUBSPOT_DEFINED', typeId: 991, label: null }],
    },
  };
}

/** Builds a demo configuration: the caller's safety switches, the bundled demo rules. */
export function loadDemoConfig(env = {}) {
  return loadGuardConfig(env, { guardDocument: JSON.parse(JSON.stringify(DEMO_GUARD_DOCUMENT)), forceMode: 'demo' });
}
