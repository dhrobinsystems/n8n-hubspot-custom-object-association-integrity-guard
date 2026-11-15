/**
 * An in-memory stand-in for the parts of the HubSpot API the guard uses. It powers demo mode,
 * the test suite and the n8n workflow simulation. It never touches the network.
 */

function errorBody(status, message) {
  return { status, body: { status: 'error', message, category: status === 404 ? 'OBJECT_NOT_FOUND' : 'VALIDATION_ERROR' } };
}

function selectProperties(record, names) {
  const properties = { hs_object_id: record.id, hs_createdate: record.createdAt, hs_lastmodifieddate: record.updatedAt || record.createdAt };
  for (const name of names) {
    if (name in properties) continue;
    properties[name] = record.properties[name] === undefined ? null : record.properties[name];
  }
  return properties;
}

function numericOrder(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b) && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createMockHubSpot(state) {
  const calls = [];

  function objectsOf(type) {
    return (state.objects && state.objects[type]) || null;
  }

  function list(type, searchParams) {
    const objects = objectsOf(type);
    if (!objects) return errorBody(400, `Unable to infer object type from: ${type}`);
    const limit = Math.min(Number(searchParams.get('limit')) || 10, state.maxPageSize || 100);
    const offset = Number(searchParams.get('after') || 0);
    const names = (searchParams.get('properties') || '').split(',').map((name) => name.trim()).filter(Boolean);
    const ids = Object.keys(objects).filter((id) => !objects[id].archived).sort(numericOrder);
    const slice = ids.slice(offset, offset + limit);
    const body = {
      results: slice.map((id) => {
        const record = { id, ...objects[id] };
        return { id, properties: selectProperties(record, names), createdAt: record.createdAt, updatedAt: record.updatedAt || record.createdAt, archived: false };
      }),
    };
    if (offset + limit < ids.length) body.paging = { next: { after: String(offset + limit), link: `mock://next?after=${offset + limit}` } };
    return { status: 200, body };
  }

  function readAssociations(fromType, toType, inputs) {
    if (!objectsOf(fromType) || !objectsOf(toType)) return errorBody(400, `Unknown object type ${!objectsOf(fromType) ? fromType : toType}`);
    const faults = (state.faults && state.faults.associationErrors) || [];
    const results = [];
    const errors = [];
    for (const input of inputs) {
      const id = String(input.id);
      if (faults.some((fault) => fault.fromType === fromType && fault.toType === toType && String(fault.id) === id)) {
        errors.push({ status: 'error', category: 'INTERNAL_ERROR', message: 'Temporary failure reading associations', context: { fromObjectId: [id] } });
        continue;
      }
      const grouped = {};
      for (const edge of state.associations) {
        if (edge.fromType !== fromType || String(edge.fromId) !== id || edge.toType !== toType) continue;
        const entry = grouped[edge.toId] || (grouped[edge.toId] = { toObjectId: Number(edge.toId), associationTypes: [] });
        entry.associationTypes.push(...edge.types);
      }
      const to = Object.values(grouped);
      if (to.length) results.push({ from: { id }, to });
      else errors.push({ status: 'error', category: 'VALIDATION_ERROR', subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND', message: `No ${toType} is associated with ${fromType} ${id}.`, context: { fromObjectId: [id] } });
    }
    return { status: errors.length ? 207 : 200, body: { status: 'COMPLETE', results, errors, numErrors: errors.length } };
  }

  function batchRead(type, body) {
    const objects = objectsOf(type);
    if (!objects) return errorBody(400, `Unable to infer object type from: ${type}`);
    const names = Array.isArray(body.properties) ? body.properties : [];
    const results = [];
    const missing = [];
    for (const input of body.inputs || []) {
      const id = String(input.id);
      const record = objects[id];
      if (!record || record.archived) { missing.push(id); continue; }
      results.push({ id, properties: selectProperties({ id, ...record }, names), createdAt: record.createdAt, updatedAt: record.updatedAt || record.createdAt, archived: false });
    }
    const errors = missing.length ? [{ status: 'error', category: 'OBJECT_NOT_FOUND', message: `Could not get some ${type} objects, they may be deleted or not exist.`, context: { ids: missing } }] : [];
    return { status: errors.length ? 207 : 200, body: { status: 'COMPLETE', results, errors, numErrors: errors.length } };
  }

  function batchUpdate(type, body) {
    const objects = objectsOf(type);
    if (!objects) return errorBody(400, `Unable to infer object type from: ${type}`);
    const results = [];
    const errors = [];
    for (const input of body.inputs || []) {
      const record = objects[String(input.id)];
      if (!record) { errors.push({ status: 'error', category: 'OBJECT_NOT_FOUND', message: 'Object not found', context: { ids: [String(input.id)] } }); continue; }
      record.properties = { ...record.properties, ...input.properties };
      results.push({ id: String(input.id), properties: { ...input.properties } });
    }
    return { status: errors.length ? 207 : 200, body: { status: 'COMPLETE', results, errors } };
  }

  async function request(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url);
    calls.push({ method, path: url.pathname, search: url.search, body: req.body === undefined ? null : JSON.parse(JSON.stringify(req.body)), headers: req.headers || {} });
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (method === 'GET' && url.pathname === '/account-info/v3/details') return { status: 200, body: { ...state.account } };
    if (method === 'GET' && url.pathname === '/crm/v3/schemas') return { status: 200, body: { results: state.schemas || [] } };
    if (parts[0] === 'crm' && parts[1] === 'v4' && parts[2] === 'associations') {
      if (method === 'POST' && parts[5] === 'batch' && parts[6] === 'read') return readAssociations(parts[3], parts[4], (req.body && req.body.inputs) || []);
      if (method === 'GET' && parts[5] === 'labels') return { status: 200, body: { results: (state.labels && state.labels[`${parts[3]}|${parts[4]}`]) || [] } };
    }
    if (parts[0] === 'crm' && parts[1] === 'v3' && parts[2] === 'objects') {
      if (method === 'GET' && parts.length === 4) return list(parts[3], url.searchParams);
      if (method === 'POST' && parts[4] === 'batch' && parts[5] === 'read') return batchRead(parts[3], req.body || {});
      if (method === 'POST' && parts[4] === 'batch' && parts[5] === 'update') return batchUpdate(parts[3], req.body || {});
    }
    if (parts[0] === 'crm' && parts[1] === 'v3' && parts[2] === 'properties') {
      const type = parts[3];
      state.propertyDefinitions = state.propertyDefinitions || {};
      const existing = state.propertyDefinitions[type] || (state.propertyDefinitions[type] = []);
      if (method === 'GET' && parts[4] === 'groups') return { status: 200, body: { results: [{ name: 'demo_information', label: 'Demo information' }] } };
      if (method === 'POST' && parts.length === 4) {
        if (existing.includes(req.body.name)) return { status: 409, body: { status: 'error', category: 'OBJECT_ALREADY_EXISTS', message: `Property ${req.body.name} already exists` } };
        existing.push(req.body.name);
        return { status: 201, body: { ...req.body } };
      }
    }
    return errorBody(404, `Mock HubSpot has no route for ${method} ${url.pathname}`);
  }

  return { request, calls, state };
}
