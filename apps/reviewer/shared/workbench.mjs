export function createWorkbench(config) {
  const REVIEW_STATUSES = Object.freeze({
    pending: '未审',
    keep: '保留',
    check: '待查',
    skip: '不用'
  });
  function validReview(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.status === 'string' && Object.hasOwn(REVIEW_STATUSES, value.status) && (value.comment === undefined || typeof value.comment === 'string');
  }
  function sanitizeReviews(input, knownIds) {
    const result = Object.create(null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
    for (const [id, r] of Object.entries(input)) {
      if (!knownIds.has(id) || ['__proto__', 'prototype', 'constructor'].includes(id) || !validReview(r)) continue;
      result[id] = {
        status: r.status,
        comment: (r.comment || '').slice(0, 10000),
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null
      };
    }
    return result;
  }
  function parseReviewImport(text, knownIds, {
    allowLegacy = false,
    exact = false
  } = {}) {
    const data = JSON.parse(text);
    if (!data || data.format !== config.importFormat || ![1, 2].includes(data.version) || !data.reviews || typeof data.reviews !== 'object' || Array.isArray(data.reviews)) throw Error(`不是支持的 ${config.label} 审阅文件`);
    if (!config.projectId || !config.datasetId) throw Error('当前项目缺少 projectId/datasetId，不能安全导入');
    if (exact && (data.version !== 2 || data.scope !== 'full-catalogue')) throw Error('精确恢复仅接受 v2 full-catalogue 完整审阅备份，不接受旧版或所选导出');
    if (data.version === 2) {
      if (data.projectId !== config.projectId || data.datasetId !== config.datasetId) throw Error('审阅备份项目或数据集身份不匹配');
    } else {
      if (data.projectId !== undefined && data.projectId !== config.projectId || data.datasetId !== undefined && data.datasetId !== config.datasetId) throw Error('旧版审阅备份声明的项目或数据集身份不匹配');
      if (!allowLegacy) {
        const error = Error('旧版 v1 备份没有完整身份保证；需确认来自当前项目及数据集后迁移');
        error.code = 'LEGACY_REVIEW_CONFIRMATION_REQUIRED';
        throw error;
      }
    }
    if (exact) {
      if (!Array.isArray(data.selected) || data.selected.some(id => typeof id !== 'string' || !knownIds.has(id)) || new Set(data.selected).size !== data.selected.length) throw Error('精确恢复的选择列表无效或包含未知 ID');
      for (const [id, review] of Object.entries(data.reviews)) {
        if (!knownIds.has(id) || ['__proto__', 'prototype', 'constructor'].includes(id) || !validReview(review) || Object.keys(review).some(key => !['status', 'comment', 'updatedAt'].includes(key)) || (review.comment?.length || 0) > 10000 || (review.updatedAt !== undefined && review.updatedAt !== null && typeof review.updatedAt !== 'string')) throw Error('精确恢复的审阅记录无效或包含未知 ID');
      }
    }
    return {
      scope: data.scope,
      reviews: sanitizeReviews(data.reviews, knownIds),
      selected: (Array.isArray(data.selected) ? data.selected : []).filter(id => typeof id === 'string' && knownIds.has(id)),
      migratedLegacy: data.version === 1
    };
  }
  function countByType(items) {
    return items.reduce((out, a) => (out[a.type] = (out[a.type] || 0) + 1, out), Object.create(null));
  }
  function availableProfile(profile) {
    return profile && profile.implemented !== false && profile.available !== false && !['unavailable', 'not-implemented', 'unsupported', 'planned'].includes(profile.status) && ['material', 'clay', 'toon', 'source', 'unlit', 'lit', 'banded', 'cozy', 'hamster'].includes(profile.mode || profile.id);
  }
  const RENDER_PREFERENCE_KEY = config.renderPreferenceKey;
  function validDefaultProfile(value, profiles) {
    const fallback = profiles.find(profile => profile.id === config.defaultProfile && profile.implemented)?.id || profiles.find(profile => profile.implemented)?.id || 'material';
    return typeof value === 'string' && profiles.some(profile => profile.id === value && profile.implemented) ? value : fallback;
  }
  function readDefaultProfile(storage, profiles) {
    try {
      const raw = storage.getItem(RENDER_PREFERENCE_KEY),
        saved = config.profileStorageFormat === 'string' ? raw : JSON.parse(raw || 'null');
      return validDefaultProfile(config.profileStorageFormat === 'string' ? saved : saved?.version === 1 ? saved.profileId : null, profiles);
    } catch {
      return validDefaultProfile(null, profiles);
    }
  }
  function writeDefaultProfile(storage, value, profiles) {
    const profileId = validDefaultProfile(value, profiles);
    try {
      storage.setItem(RENDER_PREFERENCE_KEY, config.profileStorageFormat === 'string' ? profileId : JSON.stringify({
        version: 1,
        profileId
      }));
      return {
        profileId,
        saved: true
      };
    } catch {
      return {
        profileId,
        saved: false
      };
    }
  }
  const PAGE_SIZE_OPTIONS = Object.freeze([20, 50, 100]);
  const PAGE_SIZE = PAGE_SIZE_OPTIONS[0];
  function clampPage(page, totalPages) {
    return Math.min(Math.max(1, Math.floor(page)), Math.max(1, totalPages));
  }
  function pageSlice(items, requestedPage = 1, pageSize = PAGE_SIZE) {
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE;
    const total = items.length,
      totalPages = Math.ceil(total / size);
    const numeric = Number(requestedPage);
    const page = clampPage(Number.isFinite(numeric) ? numeric : 1, totalPages);
    const start = total ? (page - 1) * size + 1 : 0,
      end = Math.min(page * size, total);
    return {
      items: items.slice(total ? start - 1 : 0, end),
      page,
      total,
      totalPages,
      start,
      end,
      hasPrevious: page > 1,
      hasNext: page < totalPages
    };
  }
  function adjacentAsset(items, currentId, direction) {
    const currentIndex = items.findIndex(item => item.id === currentId);
    if (currentIndex < 0) return null;
    return items[currentIndex + direction] ?? null;
  }
  function detailShortcut(event, {editing = false, commentFocused = false, spaceTarget = false, viewerFocused = false} = {}) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return null;
    if (event.key === 'Escape') return {type: commentFocused ? 'blurComment' : 'close'};
    if (editing || commentFocused) return null;
    // 预览画布自己处理方向键和 0（旋转与重置视角）
    if (viewerFocused && ['ArrowLeft', 'ArrowRight', '0'].includes(event.key)) return null;
    switch (event.key.toLowerCase()) {
      case '1': return {type: 'review', status: 'keep'};
      case '2': return {type: 'review', status: 'check'};
      case '3': return {type: 'review', status: 'skip'};
      case '0': return {type: 'review', status: 'pending'};
      case 'arrowleft':
      case 'k': return {type: 'adjacent', direction: -1};
      case 'arrowright':
      case 'j': return {type: 'adjacent', direction: 1};
      case 'c': return {type: 'comment'};
      case ' ': return spaceTarget ? null : {type: 'selection'};
      default: return null;
    }
  }
  function resolveJumpPage(value, totalPages) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
      value = Number(trimmed);
    }
    return Number.isFinite(value) ? clampPage(value, totalPages) : null;
  }
  function paginationTokens(page, totalPages) {
    if (totalPages <= 7) return Array.from({
      length: Math.max(0, totalPages)
    }, (_, i) => i + 1);
    const pages = new Set([1, totalPages, page - 1, page, page + 1]);
    if (page <= 3) {
      pages.add(2);
      pages.add(3);
      pages.add(4);
    }
    if (page >= totalPages - 2) {
      pages.add(totalPages - 3);
      pages.add(totalPages - 2);
      pages.add(totalPages - 1);
    }
    const sorted = [...pages].filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b),
      result = [];
    for (const n of sorted) {
      if (result.length && n - result.at(-1) > 1) result.push('…');
      result.push(n);
    }
    return result;
  }
  function createBatchReviewIntent(ids, status, updatedAt) {
    if (!Object.hasOwn(REVIEW_STATUSES, status)) throw new TypeError('Invalid review status');
    const reviews = Object.fromEntries(Array.from(ids, id => [id, {status, updatedAt}]));
    return {reviews, mergeReviews: true};
  }
  function selectionRange(items, anchorId, targetId) {
    const targetIndex = items.findIndex(item => item.id === targetId);
    if (targetIndex < 0) return [];
    const anchorIndex = items.findIndex(item => item.id === anchorId);
    if (anchorIndex < 0) return [targetId];
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return items.slice(start, end + 1).map(item => item.id);
  }
  return {
    REVIEW_STATUSES,
    validReview,
    sanitizeReviews,
    parseReviewImport,
    countByType,
    availableProfile,
    RENDER_PREFERENCE_KEY,
    validDefaultProfile,
    readDefaultProfile,
    writeDefaultProfile,
    PAGE_SIZE,
    PAGE_SIZE_OPTIONS,
    pageSlice,
    adjacentAsset,
    detailShortcut,
    resolveJumpPage,
    paginationTokens,
    createBatchReviewIntent,
    selectionRange
  };
}
export function createWorkbenchState() {
  return {
    view: "objects",
    type: "all",
    category: "all",
    query: "",
    review: "all",
    preview: "all",
    sort: "featured",
    bg: "light",
    page: 1
  };
}
