import type { Category } from './types';

export interface CategoryEntry {
  category: Category;
  depth: number;
  path: string[];
}
export function categoryEntries(categories: Category[]): CategoryEntry[] {
  const children = new Map<string | null, Category[]>();
  const ids = new Set(categories.map((c) => c.id));
  for (const category of categories) {
    const parent = category.parentId && ids.has(category.parentId) ? category.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), category]);
  }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name, 'zh-CN') ||
        a.id.localeCompare(b.id),
    );
  const result: CategoryEntry[] = [],
    seen = new Set<string>();
  const visit = (parent: string | null, path: string[]) => {
    for (const category of children.get(parent) ?? []) {
      if (seen.has(category.id)) continue;
      seen.add(category.id);
      const next = [...path, category.name];
      result.push({ category, depth: path.length, path: next });
      visit(category.id, next);
    }
  };
  visit(null, []);
  // Keep a malformed legacy branch visible, without following a cycle forever.
  for (const category of categories)
    if (!seen.has(category.id)) {
      seen.add(category.id);
      result.push({ category, depth: 0, path: [category.name] });
      visit(category.id, [category.name]);
    }
  return result;
}
export function categoryDescendants(categories: Category[], id: string): Set<string> {
  const blocked = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories)
      if (category.parentId && blocked.has(category.parentId) && !blocked.has(category.id)) {
        blocked.add(category.id);
        changed = true;
      }
  }
  return blocked;
}
