// DuckDbDataGetter — drop-in replacement for the HTTP DataGetter.
//
// Keeps the public surface the React app depends on (fetchAndCacheItems + the
// apiCalls metadata + the DataCache contract from
// archived/frontend/src/state/DataGetter.jsx) but dispatches each `api` name to
// a DuckDB-Wasm SQL function instead of axiosCall. The components, DataCache,
// and state layers are untouched. See docs/read-only-port-plan.md.
//
// Result shapes mirror the original fetchAndCacheItems:
//   apiResultShape 'array of keyed obj' -> { [key]: row, ... } (multipart keys
//     split on '.'), 'obj'/'obj of obj' -> returned as-is, singleKeyFunc and
//     concept-graph -> cached under [slice, singleKey].

import { setWith, isEmpty, uniq, difference } from 'lodash';
import { compress } from 'lz-string';
import { createSearchParams } from 'react-router-dom';

import {
  getAllCsets,
  getCsets,
  getCsetMembersItems,
  getConcepts,
  conceptSearch,
  conceptGraph,
} from './queries';

// Stand-in for the backend's last-refreshed timestamp. Bumping this (e.g. on a
// new bundle deploy) invalidates clients' localStorage caches. Vite injects
// __BUILD_TIME__ at build; falls back to a fixed value in dev.
const BUNDLE_BUILD_TIME =
  typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '2026-06-17T00:00:00Z';

// Maps the original `api` name to a function that runs the SQL and returns the
// raw rows (same JSON the FastAPI route returned).
const API_IMPL = {
  'get-all-csets': () => getAllCsets(),
  'get-csets': (codesetIds) => getCsets(codesetIds),
  'get-cset-members-items': (codesetIds) => getCsetMembersItems(codesetIds),
  concepts: (conceptIds) => getConcepts(conceptIds),
  'concept-search': (searchStr) => conceptSearch(searchStr),
  'concept-graph': ({ codeset_ids = [], cids = [] }) =>
    conceptGraph(codeset_ids, cids),
};

export class DuckDbDataGetter {
  constructor(dataCache) {
    this.dataCache = dataCache;
  }

  // No-op kept for API parity: the original allocated server-side call-group
  // ids for logging. There is no server here.
  async getApiCallGroupId() {
    this.api_call_group_id = null;
    return null;
  }

  // The HTTP DataGetter exposed axiosCall; a few callers (DataCache.cacheCheck)
  // use it directly. The only path that matters for the static demo is
  // 'last-refreshed' — return the bundle's build timestamp so cache-staleness
  // logic works (cache invalidates when a new bundle is deployed). Everything
  // else is a no-op (no server to call).
  async axiosCall(path) {
    if (path === 'last-refreshed') return BUNDLE_BUILD_TIME;
    return null;
  }

  // The apiCalls metadata, trimmed to the read-only demo endpoints. Same shape
  // as the original so callers that read these definitions keep working.
  apiCalls = {
    all_csets: {
      expectedParams: undefined,
      api: 'get-all-csets',
      cacheSlice: 'all_csets',
      key: undefined,
      apiResultShape: 'array of keyed obj',
    },
    csets: {
      expectedParams: [],
      api: 'get-csets',
      cacheSlice: 'csets',
      key: 'codeset_id',
      apiResultShape: 'array of keyed obj',
    },
    cset_members_items: {
      expectedParams: [],
      api: 'get-cset-members-items',
      cacheSlice: 'cset_members_items',
      key: 'codeset_id.concept_id',
      apiResultShape: 'array of keyed obj',
    },
    concept_graph_new: {
      expectedParams: {},
      api: 'concept-graph',
      cacheSlice: 'concept-graph',
      singleKeyFunc: ({ codeset_ids = [], cids = [] }) =>
        compress(codeset_ids.join('|') + ';' + cids.join('|')),
      apiResultShape: 'array of array [level, concept_id]',
    },
    concepts: {
      expectedParams: [],
      api: 'concepts',
      cacheSlice: 'concepts',
      key: 'concept_id',
      apiResultShape: 'array of keyed obj',
      expectOneResultRowPerKey: true,
      createStubForMissingKey: (key) => ({
        concept_id: key,
        concept_name: 'Missing concept',
        domain_id: '',
        vocabulary_id: '',
        concept_class_id: '',
        standard_concept: '',
        concept_code: '',
        invalid_reason: null,
        domain_cnt: 0,
        domain: '',
        total_cnt: 0,
        distinct_person_cnt: '0',
      }),
    },
    concept_search: {
      expectedParams: '',
      api: 'concept-search',
      singleKeyFunc: (searchStr) => searchStr,
      cacheSlice: 'search_str',
      key: 'concept_id',
      apiResultShape: 'array of keyed obj',
      expectOneResultRowPerKey: true,
    },
  };

  // Run the SQL behind an apiDef (replaces axiosCall). `data` is whatever the
  // original would have sent as params (id array, search string, or the
  // concept-graph {codeset_ids, cids} object).
  async runApi(apiDef, data) {
    const impl = API_IMPL[apiDef.api];
    if (!impl) throw new Error(`No DuckDB impl for api '${apiDef.api}'`);
    return impl(data);
  }

  // Mirrors the original fetchAndCacheItems control flow, swapping axiosCall →
  // runApi. Caching semantics and return shapes are preserved.
  async fetchAndCacheItems(apiDef, params) {
    if (typeof apiDef.expectedParams !== typeof params) {
      throw new Error('passed wrong type');
    }
    const dataCache = this.dataCache;

    // no-param calls (all_csets): whole-slice cache.
    if (typeof apiDef.expectedParams === 'undefined') {
      let data = await dataCache.cacheGet(apiDef.cacheSlice);
      if (isEmpty(data)) {
        data = await this.runApi(apiDef, params);
        dataCache.cachePut(apiDef.cacheSlice, data);
      }
      return data;
    }

    // single-key calls (concept-search, concept-graph): cache under [slice,key].
    if (apiDef.singleKeyFunc || apiDef.api === 'concept-graph') {
      const cacheKey = apiDef.singleKeyFunc
        ? apiDef.singleKeyFunc(params)
        : params.codeset_ids.join(',') + ';' + (params.cids || []).join(',');
      let data = await dataCache.cacheGet([apiDef.cacheSlice, cacheKey]);
      if (isEmpty(data)) {
        data = await this.runApi(apiDef, params);
        dataCache.cachePut([apiDef.cacheSlice, cacheKey], data);
      }
      return data;
    }

    if (isEmpty(params)) return apiDef.expectedParams;

    if (
      !['array of keyed obj', 'obj of array', 'obj of obj'].includes(
        apiDef.apiResultShape,
      )
    ) {
      throw new Error(`not sure how to handle apiDef ${apiDef.api}`);
    }

    // keyed, partial-cache calls (csets, cset_members_items, concepts):
    // only fetch keys not already cached, then keep just the requested keys.
    params = params.map(String);
    if (params.length !== uniq(params).length) {
      throw new Error('Why are you sending duplicate param values?');
    }

    const wholeCache = dataCache.cacheGet(apiDef.cacheSlice) || {};
    const cachedItems = {};
    const uncachedKeys = [];
    params.forEach((key) => {
      if (wholeCache[key]) cachedItems[key] = wholeCache[key];
      else uncachedKeys.push(key);
    });

    if (!uncachedKeys.length) return cachedItems;

    let returnData = await this.runApi(apiDef, uncachedKeys);
    if (!returnData) throw new Error(`Error fetching from ${apiDef.api}`);

    if (apiDef.expectOneResultRowPerKey) {
      if (returnData.length < uncachedKeys.length) {
        const stubs = difference(
          uncachedKeys,
          returnData.map((d) => d[apiDef.key] + ''),
        ).map((key) => apiDef.createStubForMissingKey(key));
        returnData = returnData.concat(stubs);
      } else if (returnData.length !== uncachedKeys.length) {
        throw new Error('How can there be more return rows than keys?');
      }
    }

    const uncachedItems = {};
    const keyNames = apiDef.key.split('.');
    returnData.forEach((obj) => {
      const keys = keyNames.map((k) => obj[k]);
      setWith(uncachedItems, keys, obj, Object);
    });

    const results = { ...cachedItems, ...uncachedItems };
    await dataCache.cachePut(apiDef.cacheSlice, results);
    return results;
  }
}

// re-export so components importing these from the old module path keep working.
export const backend_url = () => {
  throw new Error('backend_url is not available in the serverless demo');
};
export { createSearchParams };
