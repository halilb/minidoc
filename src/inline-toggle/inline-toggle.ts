/**
 * This file handles toggling of inline tags, such as strong, em, etc.
 * Out of the box, the browser really bungles this. The logic is complex,
 * but seems necessary.
 *
 * The basics are as follows:
 * - In the current selection, create a list of ranges that surround inlinable content
 *   - For example, p, div, h1 are not inlinable, but their contents may be
 * - If all of them are already within the desired element (e.g. strong), remove the element
 * - Else, surround them with the element
 *
 * In addition to that, we want to always make sure we normalize the final content, merging
 * any contiguous <strong> elements, for example, removing any empty text nodes, etc.
 *
 * This also adds the isActive check to the editor, since that needs to be aware of toggled tags.
 */

import * as Rng from '../range';
import * as Dom from '../dom';
import { h } from '../dom';
import { last } from '../util';
import { EditorMiddlewareMixin, MinidocBase } from '../types';

export interface InlineTogglable {
  isActive(tagName: string): boolean;
  toggleInline(tagName: string): void;
}

function normalizeTagName(tagName: string) {
  tagName = tagName.toUpperCase();
  if (tagName === 'B') {
    return 'STRONG';
  } else if (tagName === 'I') {
    return 'EM';
  }
  return tagName;
}

function normalizeSelector(tagName: string) {
  switch (tagName.toUpperCase()) {
    case 'B':
    case 'STRONG':
      return 'b,strong';
    case 'I':
    case 'EM':
      return 'i,em';
    default:
      return tagName;
  }
}

/**
 * Append b's content into a (and remove b) if both a and b match the selector.
 */
function mergeMatchingNodes(selector: string, a: Node | null, b: Node | null) {
  if (Dom.isElement(a) && a.matches(selector) && Dom.isElement(b) && b.matches(selector)) {
    Dom.appendChildren(Array.from(b.childNodes), a);
    b.remove();
    return a;
  }
}

/**
 * Ensure the element is contiguous with related elements. In other words,
 * <b>hi</b><b>there</b> -> <b>hi there</b>
 * <b>hi <b>there</b></b> -> <b>hi there</b>
 */
function makeContiguous(tagName: string, el: Element) {
  const selector = normalizeSelector(tagName);
  Array.from(el.children).forEach((child) => {
    if (child.matches(selector)) {
      Array.from(child.childNodes).forEach((n) => el.insertBefore(n, child));
      child.remove();
    }
  });
  const children = Array.from(el.childNodes);
  if (el.parentElement?.closest(selector)) {
    const parent = el.parentElement!;
    children.forEach((child) => parent.insertBefore(child, el));
    el.remove();
    el = parent;
  }
  el = mergeMatchingNodes(selector, el.previousSibling, el) || el;
  el = mergeMatchingNodes(selector, el, el.nextSibling) || el;
  return children.filter((c) => c.isConnected);
}

/**
 * Create a single range that encompasses the array of ranges.
 */
function toRange(ranges: Range[]) {
  const range = ranges[0].cloneRange();
  const tail = last(ranges);
  tail && range.setEnd(tail.endContainer, tail.endOffset);
  return range;
}

/**
 * Get a set of tags between node and its ancestor that matches the selector.
 */
function getInlineTags(until: string, node: Node | undefined) {
  const tagNames = new Set<string>();
  let el: Element | undefined = Dom.isElement(node) ? node : node?.parentElement || undefined;
  while (el && !el.matches(until) && !Dom.isBlock(el)) {
    tagNames.add(el.tagName);
    el = el.parentElement || undefined;
  }
  return tagNames;
}

/**
 * Removes the inline tag from the range.
 */
export function unapply(tagName: string, r: Range) {
  const selector = normalizeSelector(tagName);
  // Track all tags between our range and the ancestor we're leaving.
  // So, if we are attempting to remove b from this: <b><i>foo</i></b>
  // we'll end up with <i>foo</i> rather than just foo.
  const tagNames = getInlineTags(selector, Rng.toNode(r));

  // Remove the content. We'll sanitize it and re-insert it in a bit.
  let content: Element | DocumentFragment = r.extractContents();

  // If we're in a subsection of a larger tag, we'll split that tag
  // so that we can sandwich our final (unstyled) content within two
  // styled tags.
  const closest = Dom.closest(selector, Rng.toNode(r));
  if (closest) {
    r.setEndAfter(closest);
    const tailContent = r.extractContents();
    !Dom.isEmpty(tailContent) && r.insertNode(tailContent);
    Dom.isEmpty(closest) && closest.remove();
  }

  // Remove all children that match the inline selector.
  Array.from(content.querySelectorAll(selector)).forEach((n) => Dom.replaceSelfWithChildren(n));
  r.collapse(true);

  // Restore our tag names, if any
  tagNames.forEach((tag) => {
    content = h(tag, content);
  });

  // Insert our cleaned up content.
  r.insertNode(content);
}

function shouldEnable(selector: string, ranges: Range[]) {
  const node = Rng.toNode(ranges[0]);
  const el = Dom.isElement(node) ? node : node?.parentElement;
  const isWithin = el?.closest(selector);
  const contains = Dom.isElement(node) && node.querySelector(selector);
  return !isWithin && !contains;
}

function toggleInlineSelection(tagName: string, range: Range) {
  if (range.collapsed) {
    return range;
  }

  const selector = normalizeSelector(tagName);
  const ranges = Rng.inlinableRanges(range);
  if (!ranges.length) {
    return range;
  }
  if (shouldEnable(selector, ranges)) {
    ranges.forEach((r) => {
      const el = h(tagName, r.extractContents());
      r.insertNode(el);
      const children = makeContiguous(tagName, el);
      Rng.$copy(r, Rng.fromNodes(children));
    });
  } else {
    ranges.forEach((r) => unapply(tagName, r));
  }
  const result = toRange(ranges);
  const container = result.commonAncestorContainer;
  Dom.isElement(container) &&
    Array.from(container.querySelectorAll(selector)).forEach((n) => Dom.isEmpty(n) && n.remove());
  return result;
}

export const inlineTogglable: EditorMiddlewareMixin<InlineTogglable> = (next, editor) => {
  const result = editor as MinidocBase & InlineTogglable;
  const el = editor.root;
  // The tags within which the current selection resides
  const activeTags = new Set<string>();
  // The tags which are toggled (will affect the next input)
  const toggledTags = new Set<string>();
  // When we're toggling an inline tag, we trigger a selection change
  // which in turn clears the toggled tags. So, we need to ignore that
  // particular selection change. This flag is how we do that.
  let isToggling = false;

  function toggleInline(tagName: string) {
    let range = Rng.currentRange();
    if (!range) {
      return;
    }
    if (!range.collapsed) {
      range = toggleInlineSelection(tagName, range);
    } else {
      isToggling = true;
      const normalized = normalizeTagName(tagName);
      toggledTags.has(normalized) ? toggledTags.delete(normalized) : toggledTags.add(normalized);
      // Hack for FireFox, which calls caret change several
      // times when toggling inline styles.
      setTimeout(() =>
        setTimeout(() => {
          isToggling = false;
        }),
      );
    }
    Rng.setCurrentSelection(range);
  }

  // When the editor's caret / selection changes, we need to
  // recompute the active tags and reset the toggled tags.
  Dom.on(el, 'mini:caretchange', () => {
    if (isToggling) {
      return;
    }
    const range = Rng.currentRange();
    if (!range) {
      return;
    }
    let child = Rng.toNode(range);
    activeTags.clear();
    toggledTags.clear();
    while (true) {
      const parent = child.parentElement;
      if (!parent || Dom.isRoot(parent)) {
        break;
      }
      activeTags.add(normalizeTagName(parent.tagName));
      child = parent;
    }
  });

  // If the user enters anything and we have some toggled tags,
  // we need to apply the toggled tags.
  Dom.on(el, 'keypress', (e) => {
    if (!toggledTags.size) {
      return;
    }
    let range = Rng.currentRange()!;
    if (!range) {
      return;
    }
    e.preventDefault();
    const node = document.createTextNode(e.key);
    range.deleteContents();
    range.insertNode(node);
    toggledTags.forEach((k) => {
      range = toggleInlineSelection(k, range);
    });
    range.collapse();
    Rng.setCurrentSelection(range);
    toggledTags.clear();
  });

  Dom.on(el, 'keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) {
      return;
    }
    if (e.code === 'KeyB') {
      e.preventDefault();
      toggleInline('strong');
    } else if (e.code === 'KeyI') {
      e.preventDefault();
      toggleInline('em');
    }
  });

  result.isActive = (tagName) => {
    const normalized = normalizeTagName(tagName);
    return activeTags.has(normalized) === !toggledTags.has(normalized);
  };

  result.toggleInline = toggleInline;

  return next(result);
};
